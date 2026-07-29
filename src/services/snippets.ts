import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
/** Délai avant de réessayer un mail dont la lecture a échoué (anti-boucle). */
const RETRY_AFTER_MS = 60 * 60_000;

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
  /** Mails d'un dossier en panne, remis à plus tard (pas perdus). */
  deferred: number;
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

  // ANTI-BOUCLE (constaté en réel le 29/07) : quand un dossier échoue (socket
  // IMAP qui expire, boîte injoignable), ses mails restent sans extrait et
  // repartaient dans le lot suivant — le rattrapage tournait en rond sans
  // jamais avancer. On note donc la TENTATIVE (`snippetAt`) même en échec, et
  // on ne réessaie ces mails qu'après un délai. Rien n'est perdu : ils
  // restent comptés dans `remaining` et seront repris plus tard.
  const selectWhere = {
    ...where,
    OR: [{ snippetAt: null }, { snippetAt: { lt: new Date(Date.now() - RETRY_AFTER_MS) } }],
  };

  const pending = await db.message.findMany({
    where: selectWhere,
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
    deferred: 0,
    remaining: 0,
  };
  if (pending.length === 0) {
    // Rien de sélectionnable : soit tout est lu, soit les mails restants sont
    // en attente de réessai (dossier en panne). `remaining` dit la vérité.
    result.remaining = await db.message.count({ where });
    return result;
  }

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
  /** Mails d'un dossier en panne : tentative datée, extrait laissé vide. */
  const failed: number[] = [];

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
      // Tentative datée sans extrait : ces mails ne reviendront pas au tour
      // suivant (sinon le rattrapage boucle sur le dossier en panne), mais
      // restent à faire et seront réessayés après RETRY_AFTER_MS.
      failed.push(...messages.map((m) => m.id));
      progress(
        `⚠️ ${folderPath} ignoré (${(err as Error).message}) — ${messages.length} mail(s) réessayés plus tard.`,
      );
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
  // Dossiers en panne : on date la tentative sans poser d'extrait.
  for (let i = 0; i < failed.length; i += 200) {
    await db.message.updateMany({
      where: { id: { in: failed.slice(i, i + 200) } },
      data: { snippetAt: now },
    });
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

  result.deferred = failed.length;
  result.remaining = await db.message.count({ where });
  progress(
    `${rec.account} : ${result.filled} extrait(s) capturé(s), ${result.empty} sans texte, ` +
      (result.deferred ? `${result.deferred} remis à plus tard, ` : '') +
      `${result.intentsImproved} intention(s) précisée(s) — reste ${result.remaining}.`,
  );
  return result;
}

// ----------------------------------------- Réparation des extraits en charabia

/**
 * Répare un extrait victime du classique « UTF-8 lu comme du latin-1 » :
 * « voilÃ  » au lieu de « voilà », « Ã© » au lieu de « é ». Fréquent sur les
 * mails d'avant 2010, qui déclarent souvent un jeu de caractères faux.
 *
 * Retourne null quand il n'y a rien à faire — le texte est déjà propre, la
 * réparation ne change rien, ou elle produit des caractères de remplacement
 * (signe qu'on s'est trompé de piste). Dans le doute, on ne touche pas.
 *
 * Le décodage IMAP est corrigé à la source (decodeText), mais les extraits
 * DÉJÀ capturés gardent leur charabia : cette réparation les rattrape sans
 * avoir à relire les boîtes.
 */
export function repairMojibake(text: string): string | null {
  if (!text) return null;
  // Signature du charabia : un octet 0xC2/0xC3 suivi d'un octet de
  // continuation UTF-8 (0x80-0xBF). Comparaison de CODES et non plage
  // littérale : écrits en clair, ces caractères se font manger à la copie et
  // la plage devient fausse sans que rien ne le signale (constaté).
  let looksMangled = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Un vrai caractère hors latin-1 prouve que le texte n'est PAS une suite
    // d'octets mal lus : le repasser en latin-1 le détruirait.
    if (c > 0xff) return null;
    const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
    if ((c === 0xc2 || c === 0xc3) && next >= 0x80 && next <= 0xbf) looksMangled = true;
  }
  if (!looksMangled) return null;
  const repaired = Buffer.from(text, 'latin1').toString('utf8');
  // U+FFFD = la relecture a produit des caractères de remplacement : on s'est
  // trompé de piste, on ne touche à rien.
  if (repaired.includes('\uFFFD') || repaired === text) return null;
  return repaired;
}

/**
 * Passe de réparation sur TOUS les extraits déjà en base. Aucune connexion
 * IMAP : c'est une relecture des octets, pas des mails.
 */
export async function repairSnippets(
  progress: (m: string) => void = () => {},
): Promise<{ scanned: number; repaired: number }> {
  await ensureDbReady();
  let cursor = 0;
  let scanned = 0;
  let repaired = 0;
  for (;;) {
    const batch = await db.message.findMany({
      where: { snippet: { not: null }, id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: 1000,
      select: { id: true, snippet: true },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    scanned += batch.length;

    const fixes: { id: number; snippet: string }[] = [];
    for (const m of batch) {
      const fixed = repairMojibake(m.snippet ?? '');
      if (fixed) fixes.push({ id: m.id, snippet: fixed });
    }
    for (let i = 0; i < fixes.length; i += 100) {
      await db.$transaction(
        fixes.slice(i, i + 100).map((f) =>
          db.message.update({ where: { id: f.id }, data: { snippet: f.snippet } }),
        ),
      );
    }
    repaired += fixes.length;
    if (scanned % 5000 === 0) progress(`${scanned} extraits examinés, ${repaired} réparés…`);
  }
  progress(`Réparation terminée : ${repaired} extrait(s) remis d'aplomb sur ${scanned}.`);
  return { scanned, repaired };
}

// ------------------------------------------- Rattrapage repris après redémarrage

export type BackfillScope = 'recent' | 'all';

export interface PendingBackfill {
  scope: BackfillScope;
  requestedAt: string;
}

/**
 * Marqueur sur DISQUE de « l'utilisateur a demandé un rattrapage ».
 *
 * POURQUOI un fichier et pas la mémoire : les jobs vivent dans le processus.
 * Or le serveur redémarre à chaque mise à jour — et depuis que celles-ci sont
 * automatiques, ça arrive toutes les nuits. Un rattrapage de plusieurs heures
 * mourait donc en silence, en laissant l'interface afficher des compteurs
 * figés (constaté en réel le 29/07 : le job est mort à 09h26, l'utilisateur
 * l'a vu bloqué sans comprendre pourquoi). Le marqueur permet au serveur de
 * REPRENDRE tout seul au démarrage suivant.
 */
const MARKER = (): string => resolve(process.cwd(), 'data', 'snippet-backfill.json');

export function requestBackfill(scope: BackfillScope): void {
  try {
    const path = MARKER();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ scope, requestedAt: new Date().toISOString() }), 'utf8');
  } catch (err) {
    logger.warn('marqueur de rattrapage non écrit', { error: (err as Error).message });
  }
}

export function pendingBackfill(): PendingBackfill | null {
  try {
    const path = MARKER();
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PendingBackfill>;
    return raw.scope === 'all' || raw.scope === 'recent'
      ? { scope: raw.scope, requestedAt: raw.requestedAt ?? '' }
      : null;
  } catch {
    return null;
  }
}

export function clearBackfill(): void {
  try {
    const path = MARKER();
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* le marqueur disparaîtra au prochain passage */
  }
}

/** Plafond par passage : un job ne tourne pas indéfiniment (il est repris). */
const MAX_ROUNDS = 40;

/**
 * Rattrapage sur TOUTES les boîtes, par lots, jusqu'à épuisement ou plafond.
 * Partagé par le bouton de l'interface et par la reprise au démarrage — un
 * seul comportement. Le marqueur n'est effacé que lorsqu'il ne reste plus rien
 * à lire : tant qu'il subsiste du travail, un redémarrage reprend la main.
 */
export async function runBackfillAllAccounts(
  scope: BackfillScope,
  progress: (m: string) => void = () => {},
): Promise<Record<string, unknown>> {
  const { listAccountNames, resolveAccount } = await import('./accounts.js');
  const sinceDays = scope === 'all' ? null : undefined;
  const results: Record<string, unknown> = {};
  let leftOver = 0;

  for (const name of await listAccountNames()) {
    try {
      const rec = await resolveAccount(name);
      let filled = 0;
      let empty = 0;
      let intents = 0;
      let remaining = 0;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        progress(`[${name}] lecture des mails — lot ${round + 1}…`);
        const r = await backfillSnippets(rec, { sinceDays, onProgress: progress });
        filled += r.filled;
        empty += r.empty;
        intents += r.intentsImproved;
        remaining = r.remaining;
        if (r.scanned === 0 || remaining === 0) break;
      }
      leftOver += remaining;
      results[name] = { filled, empty, intentsImproved: intents, remaining };
    } catch (err) {
      results[name] = { error: (err as Error).message };
      progress(`⚠️ ${name} en échec (${(err as Error).message}) — on continue.`);
    }
  }

  if (leftOver === 0) {
    clearBackfill();
    progress('✅ Plus aucun mail à lire — rattrapage terminé.');
  } else {
    progress(`⏸️ ${leftOver} mail(s) restants — la lecture reprendra automatiquement.`);
  }
  return { ...results, remaining: leftOver };
}

export interface AccountCoverage {
  account: string;
  /** Mails entrants indexés (hors corbeille/spam, non supprimés). */
  total: number;
  /** Idem, sur les 3 derniers mois. */
  recent: number;
  /** Mails sans extrait de texte (dans la fenêtre de 3 mois). */
  recentWithoutSnippet: number;
  /**
   * Mails sans extrait sur TOUTE la boîte. C'est ce chiffre qui bouge quand
   * le rattrapage « toute la boîte » tourne — sans lui, l'interface affichait
   * un compteur figé à 0 (celui des 3 mois) et donnait l'impression que rien
   * ne se passait (retour utilisateur 29/07).
   */
  withoutSnippet: number;
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
      withoutSnippet: total - withSnippet,
      lowConfidence,
      snippetCoveragePct: total === 0 ? 0 : Math.round((withSnippet / total) * 100),
    });
  }

  const sum = (pick: (a: AccountCoverage) => number): number =>
    accounts.reduce((n, a) => n + pick(a), 0);
  const totalAll = sum((a) => a.total);
  // Somme EXACTE des sans-extrait (et non une reconstitution à partir des
  // pourcentages arrondis, qui dérivait de quelques mails).
  const withoutSnippetAll = sum((a) => a.withoutSnippet);
  return {
    accounts,
    totals: {
      total: totalAll,
      recent: sum((a) => a.recent),
      recentWithoutSnippet: sum((a) => a.recentWithoutSnippet),
      withoutSnippet: withoutSnippetAll,
      lowConfidence: sum((a) => a.lowConfidence),
      snippetCoveragePct:
        totalAll === 0 ? 0 : Math.round(((totalAll - withoutSnippetAll) / totalAll) * 100),
    },
  };
}
