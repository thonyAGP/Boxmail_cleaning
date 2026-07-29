import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';
import { imapService } from './imap.js';
import type { AccountRecord } from './accounts.js';
import { stripQuotedText } from './attention.js';
import { detectIntent } from './categorize.js';

/**
 * Extraits de texte (C1 — Série C, « comprendre le contenu »).
 *
 * L'index ne contenait AUCUN texte de mail : sujet, expéditeur, dates, drapeaux
 * et rien d'autre. Ni les heuristiques ni une IA ne peuvent juger un mail
 * qu'elles ne lisent pas — c'était le vrai plafond du tri. Ce service capture
 * ~500 caractères de texte par mail, via une descente IMAP qui ne télécharge
 * QUE la partie texte (jamais les pièces jointes).
 *
 * Deux usages :
 *  - rattrapage (job « extraits ») : les plus ANCIENS d'abord, reprenable ;
 *  - passe post-sync : les plus RÉCENTS d'abord, pour que le flux courant
 *    ait toujours son extrait.
 */

export const SNIPPET_MAX_CHARS = 500;
/** Fenêtre par défaut : les 3 derniers mois (la demande utilisateur). */
export const SNIPPET_WINDOW_DAYS = 90;

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 2000;

/**
 * Transforme le texte brut d'un mail en extrait lisible : texte cité retiré
 * (on veut ce que l'expéditeur écrit, pas l'historique du fil), espaces et
 * sauts de ligne réduits, coupe à `maxChars`.
 *
 * Cas limite : un simple transfert peut n'être QUE du texte cité — retirer la
 * citation ne laisserait rien. Dans ce cas on garde le texte d'origine : un
 * extrait avec citation vaut mieux que pas d'extrait.
 */
export function cleanSnippet(raw: string, maxChars = SNIPPET_MAX_CHARS): string {
  const flatten = (s: string): string =>
    s
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
      .filter(Boolean)
      .join(' ')
      .trim();

  let text = flatten(stripQuotedText(raw));
  if (!text) text = flatten(raw);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

export interface BackfillOptions {
  /** Nombre de mails traités dans cette passe (défaut 300, max 2000). */
  limit?: number;
  /** Fenêtre en jours ; `null` = toute la boîte (défaut : 90 jours). */
  sinceDays?: number | null;
  /** 'oldest' = rattrapage (défaut) ; 'newest' = flux courant (post-sync). */
  order?: 'oldest' | 'newest';
  /**
   * false = ne pas recalculer la confiance ici (l'appelant s'en charge juste
   * après — c'est le cas de la sync, qui enchaîne sa propre passe).
   */
  recomputeConfidence?: boolean;
  onProgress?: (message: string) => void;
}

export interface BackfillResult {
  scanned: number;
  /** Mails ayant reçu un extrait non vide. */
  filled: number;
  /** Mails traités sans texte exploitable (structure atypique, corps vide). */
  empty: number;
  /** Mails dont l'intention s'est précisée grâce à l'extrait. */
  intentsImproved: number;
  /** Reste-t-il des mails sans extrait dans la fenêtre ? (pour reprendre) */
  remaining: number;
}

/**
 * Capture les extraits manquants d'une boîte. REPRENABLE : chaque passe traite
 * un lot borné et renvoie `remaining` — l'appelant relance tant qu'il reste du
 * travail. Une erreur sur un dossier n'arrête pas les autres.
 */
export async function backfillSnippets(
  rec: AccountRecord,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  await ensureDbReady();
  const progress = opts.onProgress ?? (() => {});
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const sinceDays = opts.sinceDays === undefined ? SNIPPET_WINDOW_DAYS : opts.sinceDays;
  const order = opts.order ?? 'oldest';

  const where = {
    accountSlug: rec.account,
    isDeleted: false,
    isOutbound: false,
    snippet: null,
    // Corbeille et spam : rien à comprendre là-dedans.
    folder: { is: { role: { notIn: ['trash', 'spam'] } } },
    ...(sinceDays !== null
      ? { date: { gte: new Date(Date.now() - sinceDays * 86_400_000) } }
      : {}),
  };

  const pending = await db.message.findMany({
    where,
    orderBy: { date: order === 'oldest' ? 'asc' : 'desc' },
    take: limit,
    select: {
      id: true,
      uid: true,
      subject: true,
      fromEmail: true,
      hasListUnsubscribe: true,
      intent: true,
      folder: { select: { path: true } },
    },
  });

  const result: BackfillResult = {
    scanned: 0,
    filled: 0,
    empty: 0,
    intentsImproved: 0,
    remaining: 0,
  };
  if (pending.length === 0) return result;

  // Regroupé par dossier : un seul verrouillage de boîte par dossier.
  const byFolder = new Map<string, typeof pending>();
  for (const m of pending) {
    const arr = byFolder.get(m.folder.path) ?? [];
    arr.push(m);
    byFolder.set(m.folder.path, arr);
  }
  progress(
    `${pending.length} mail(s) sans extrait dans ${byFolder.size} dossier(s) — récupération du texte…`,
  );

  const updates: { id: number; snippet: string }[] = [];
  const intentUpdates: { id: number; intent: string; reason: string }[] = [];

  for (const [folderPath, messages] of byFolder) {
    try {
      const texts = await imapService.fetchSnippets(
        rec,
        folderPath,
        messages.map((m) => m.uid),
      );
      for (const m of messages) {
        result.scanned++;
        const raw = texts.get(m.uid);
        // Pas de texte exploitable : on enregistre un extrait VIDE (et non
        // null) pour marquer « déjà tenté » — sinon ce mail reviendrait à
        // chaque passe et le rattrapage n'avancerait jamais.
        const snippet = raw ? cleanSnippet(raw) : '';
        if (snippet) result.filled++;
        else result.empty++;
        updates.push({ id: m.id, snippet });

        // L'extrait sert tout de suite, sans IA : quand le SUJET seul n'a rien
        // donné (intention « info »), on rejoue la détection avec le texte.
        // Le sujet garde la priorité — aucune régression sur les cas déjà bons.
        if (snippet && (m.intent === null || m.intent === 'info')) {
          const r = detectIntent({
            subject: m.subject,
            hasListUnsubscribe: m.hasListUnsubscribe,
            fromEmail: m.fromEmail,
            snippet,
          });
          // On n'entre ici que si l'intention valait null ou « info » : dès que
          // la relecture donne autre chose, c'est un gain.
          if (r.intent !== 'info') {
            intentUpdates.push({ id: m.id, intent: r.intent, reason: r.reason });
          }
        }
      }
    } catch (err) {
      logger.warn('extraits : dossier ignoré', {
        account: rec.account,
        folder: folderPath,
        error: (err as Error).message,
      });
      progress(`⚠️ ${folderPath} ignoré (${(err as Error).message}) — on continue.`);
    }
  }

  // Écriture groupée : SQLite est en connection_limit=1, une transaction par
  // paquet vaut mieux que des centaines d'écritures isolées.
  const now = new Date();
  for (let i = 0; i < updates.length; i += 100) {
    await db.$transaction(
      updates.slice(i, i + 100).map((u) =>
        db.message.update({
          where: { id: u.id },
          data: { snippet: u.snippet, snippetAt: now },
        }),
      ),
    );
  }
  for (let i = 0; i < intentUpdates.length; i += 100) {
    await db.$transaction(
      intentUpdates.slice(i, i + 100).map((u) =>
        db.message.update({
          where: { id: u.id },
          data: { intent: u.intent, intentReason: u.reason },
        }),
      ),
    );
  }
  result.intentsImproved = intentUpdates.length;

  // Les intentions ont changé ⇒ la confiance (B4) qui en découle doit suivre.
  // ATTENTION au piège : on ne remet PAS `analysisConfidence` à null pour
  // forcer un recalcul « onlyMissing ». Une confiance nulle n'est pas
  // « faible » — elle ne déclenche donc PAS la protection B1, et une rétention
  // automatique lancée entre-temps pourrait viser ces mails. On recalcule
  // directement, en entier : l'opération est idempotente et n'écrit que les
  // changements.
  if (result.intentsImproved > 0 && opts.recomputeConfidence !== false) {
    const { computeConfidenceForAccount } = await import('./categorize.js');
    await computeConfidenceForAccount(rec.account, {}, progress);
  }

  result.remaining = await db.message.count({ where });
  progress(
    `${rec.account} : ${result.filled} extrait(s) capturé(s), ${result.empty} sans texte, ` +
      `${result.intentsImproved} intention(s) précisée(s) — reste ${result.remaining}.`,
  );
  return result;
}

export interface AccountCoverage {
  account: string;
  /** Mails entrants indexés (hors corbeille/spam, non supprimés). */
  total: number;
  /** Idem, sur les 3 derniers mois. */
  recent: number;
  /** Mails sans extrait de texte (dans la fenêtre de 3 mois). */
  recentWithoutSnippet: number;
  /** Mails dont l'analyse est jugée « faible » ⇒ protégés de tout nettoyage. */
  lowConfidence: number;
  /** Part des mails porteurs d'un extrait, en % (0-100). */
  snippetCoveragePct: number;
}

/**
 * Photographie de l'état de l'analyse (C0) — la mesure « avant ». Sert à
 * dimensionner le rattrapage et, plus tard, à prouver le gain. Index-only.
 */
export async function analysisCoverage(): Promise<{
  accounts: AccountCoverage[];
  totals: Omit<AccountCoverage, 'account'>;
}> {
  await ensureDbReady();
  const { listAccountNames } = await import('./accounts.js');
  const names = await listAccountNames();
  const cutoff = new Date(Date.now() - SNIPPET_WINDOW_DAYS * 86_400_000);
  const base = {
    isDeleted: false,
    isOutbound: false,
    folder: { is: { role: { notIn: ['trash', 'spam'] } } },
  };

  const accounts: AccountCoverage[] = [];
  for (const account of names) {
    const scope = { ...base, accountSlug: account };
    const [total, recent, recentWithoutSnippet, lowConfidence, withSnippet] = await Promise.all([
      db.message.count({ where: scope }),
      db.message.count({ where: { ...scope, date: { gte: cutoff } } }),
      db.message.count({ where: { ...scope, date: { gte: cutoff }, snippet: null } }),
      db.message.count({ where: { ...scope, analysisConfidence: 'low' } }),
      db.message.count({ where: { ...scope, snippet: { not: null } } }),
    ]);
    accounts.push({
      account,
      total,
      recent,
      recentWithoutSnippet,
      lowConfidence,
      snippetCoveragePct: total === 0 ? 0 : Math.round((withSnippet / total) * 100),
    });
  }

  const sum = (pick: (a: AccountCoverage) => number): number =>
    accounts.reduce((n, a) => n + pick(a), 0);
  const totalAll = sum((a) => a.total);
  const withSnippetAll = accounts.reduce(
    (n, a) => n + Math.round((a.snippetCoveragePct / 100) * a.total),
    0,
  );
  return {
    accounts,
    totals: {
      total: totalAll,
      recent: sum((a) => a.recent),
      recentWithoutSnippet: sum((a) => a.recentWithoutSnippet),
      lowConfidence: sum((a) => a.lowConfidence),
      snippetCoveragePct: totalAll === 0 ? 0 : Math.round((withSnippetAll / totalAll) * 100),
    },
  };
}
