import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';
import { imapService } from './imap.js';
import { recordOperation } from './oplog.js';
import type { AccountRecord } from './accounts.js';

/**
 * Désinscription des listes (P2.2).
 *
 * Tarir le flux à la source : plutôt que de supprimer indéfiniment les mêmes
 * newsletters, on demande à l'expéditeur d'arrêter de les envoyer.
 *
 * Trois voies, de la plus sûre à la moins sûre :
 *  1. UN CLIC (RFC 8058) — l'expéditeur déclare accepter une désinscription
 *     par simple appel HTTP. Aucune page à ouvrir, aucune confirmation :
 *     c'est net, et c'est la voie privilégiée.
 *  2. MAIL — on envoie un message à l'adresse de désinscription indiquée.
 *  3. LIEN — il reste une page web à ouvrir soi-même. On ne clique JAMAIS
 *     automatiquement : chez un expéditeur douteux, cela confirmerait surtout
 *     que l'adresse est vivante.
 *
 * Rien n'est automatique : chaque désinscription est demandée explicitement
 * et journalisée.
 */

export type UnsubscribeMethod = 'one-click' | 'mail' | 'lien';

export interface UnsubscribableSender {
  account: string;
  email: string;
  displayName: string | null;
  messageCount: number;
  /** Mails encore présents dans l'index (ce que ça libérerait à terme). */
  unseenCount: number;
  totalSizeBytes: number;
  lastMessageAt: string | null;
  method: UnsubscribeMethod;
  httpUrl: string | null;
  mailto: string | null;
  unsubscribedAt: string | null;
  note: string | null;
}

/**
 * Analyse un en-tête List-Unsubscribe.
 * Format : `<https://…>, <mailto:…?subject=unsubscribe>` (ordre libre).
 */
export function parseListUnsubscribe(raw: string): { http: string | null; mailto: string | null } {
  let http: string | null = null;
  let mailto: string | null = null;
  for (const m of raw.matchAll(/<([^>]+)>/g)) {
    const v = m[1].trim();
    if (/^https?:\/\//i.test(v) && !http) http = v;
    else if (/^mailto:/i.test(v) && !mailto) mailto = v.slice('mailto:'.length);
  }
  // Certains expéditeurs omettent les chevrons.
  if (!http && !mailto) {
    const bare = raw.trim();
    if (/^https?:\/\//i.test(bare)) http = bare;
    else if (/^mailto:/i.test(bare)) mailto = bare.slice('mailto:'.length);
  }
  return { http, mailto };
}

/** RFC 8058 : `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. */
export function hasOneClick(rawPostHeader: string | undefined): boolean {
  return !!rawPostHeader && /list-unsubscribe\s*=\s*one-click/i.test(rawPostHeader);
}

function methodOf(s: {
  unsubscribeOneClick: boolean;
  unsubscribeHttp: string | null;
  unsubscribeMailto: string | null;
}): UnsubscribeMethod | null {
  if (s.unsubscribeOneClick && s.unsubscribeHttp) return 'one-click';
  if (s.unsubscribeMailto) return 'mail';
  if (s.unsubscribeHttp) return 'lien';
  return null;
}

/**
 * Récupère les liens de désinscription des expéditeurs de type liste.
 *
 * L'en-tête n'existe que dans le mail : on lit donc, PAR EXPÉDITEUR, les
 * en-têtes de son dernier mail (envelope + 2 en-têtes, aucun corps — c'est
 * très léger). Idempotent : on ne retraite pas un expéditeur déjà résolu.
 */
export async function refreshUnsubscribeLinks(
  rec: AccountRecord,
  opts: { limit?: number; onProgress?: (m: string) => void } = {},
): Promise<{ scanned: number; found: number }> {
  await ensureDbReady();
  const progress = opts.onProgress ?? (() => {});
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);

  // Expéditeurs « liste » sans lien connu, les plus volumineux d'abord.
  const senders = await db.sender.findMany({
    where: {
      accountSlug: rec.account,
      unsubscribeHttp: null,
      unsubscribeMailto: null,
      OR: [{ unsubscribeCount: { gt: 0 } }, { category: { in: ['newsletter', 'ad'] } }],
    },
    orderBy: { messageCount: 'desc' },
    take: limit,
    select: { id: true, email: true },
  });
  if (senders.length === 0) return { scanned: 0, found: 0 };
  progress(`${senders.length} expéditeur(s) à examiner…`);

  let found = 0;
  let scanned = 0;
  for (const s of senders) {
    // Le mail le plus récent de cet expéditeur, encore présent.
    const msg = await db.message.findFirst({
      where: { accountSlug: rec.account, fromEmail: s.email, isDeleted: false },
      orderBy: { date: 'desc' },
      select: { uid: true, folder: { select: { path: true } } },
    });
    if (!msg) continue;
    scanned++;
    try {
      const headers = await imapService.fetchUnsubscribeHeaders(rec, msg.folder.path, msg.uid);
      if (!headers?.listUnsubscribe) continue;
      const { http, mailto } = parseListUnsubscribe(headers.listUnsubscribe);
      if (!http && !mailto) continue;
      await db.sender.update({
        where: { id: s.id },
        data: {
          unsubscribeHttp: http,
          unsubscribeMailto: mailto,
          unsubscribeOneClick: hasOneClick(headers.listUnsubscribePost) && !!http,
        },
      });
      found++;
      if (found % 10 === 0) progress(`…${found} lien(s) de désinscription trouvé(s)`);
    } catch (err) {
      logger.warn('lecture des en-têtes de désinscription en échec', {
        account: rec.account,
        sender: s.email,
        error: (err as Error).message,
      });
    }
  }
  progress(`✅ ${found} lien(s) trouvé(s) sur ${scanned} expéditeur(s) examiné(s).`);
  return { scanned, found };
}

/** Expéditeurs dont on peut se désinscrire, les plus volumineux d'abord. */
export async function listUnsubscribable(
  accountSlug?: string,
  opts: { includeDone?: boolean } = {},
): Promise<UnsubscribableSender[]> {
  await ensureDbReady();
  const rows = await db.sender.findMany({
    where: {
      ...(accountSlug ? { accountSlug } : {}),
      OR: [{ unsubscribeHttp: { not: null } }, { unsubscribeMailto: { not: null } }],
      ...(opts.includeDone ? {} : { unsubscribedAt: null }),
    },
    orderBy: { messageCount: 'desc' },
  });
  return rows
    .map((s) => {
      const method = methodOf(s);
      return method === null
        ? null
        : {
            account: s.accountSlug,
            email: s.email,
            displayName: s.displayName,
            messageCount: s.messageCount,
            unseenCount: s.unseenCount,
            totalSizeBytes: Number(s.totalSizeBytes),
            lastMessageAt: s.lastMessageAt?.toISOString() ?? null,
            method,
            httpUrl: s.unsubscribeHttp,
            mailto: s.unsubscribeMailto,
            unsubscribedAt: s.unsubscribedAt?.toISOString() ?? null,
            note: s.unsubscribeNote,
          };
    })
    .filter((x): x is UnsubscribableSender => x !== null);
}

export interface UnsubscribeResult {
  email: string;
  method: UnsubscribeMethod;
  /** true = la demande est partie ; false = il reste une page à ouvrir. */
  done: boolean;
  message: string;
  /** Page à ouvrir soi-même quand aucune voie automatique n'existe. */
  openUrl?: string;
}

/**
 * Se désinscrire d'un expéditeur. JAMAIS automatique : appelé sur demande
 * explicite, et journalisé. Le mail « lien » ne clique rien tout seul.
 */
export async function unsubscribeSender(
  rec: AccountRecord,
  email: string,
): Promise<UnsubscribeResult> {
  await ensureDbReady();
  const normalized = email.trim().toLowerCase();
  const sender = await db.sender.findUnique({
    where: { accountSlug_email: { accountSlug: rec.account, email: normalized } },
  });
  if (!sender) throw new Error(`Expéditeur inconnu de l'index : ${normalized}`);
  const method = methodOf(sender);
  if (!method) throw new Error("Aucun lien de désinscription connu pour cet expéditeur.");

  const finish = async (done: boolean, note: string): Promise<void> => {
    await db.sender.update({
      where: { id: sender.id },
      data: { unsubscribedAt: done ? new Date() : null, unsubscribeNote: note },
    });
    await recordOperation({
      account: rec.account,
      tool: 'ui_unsubscribe',
      params: { email: normalized, method },
      result: note,
    });
  };

  if (method === 'one-click') {
    // RFC 8058 : un POST suffit, rien à confirmer.
    try {
      const res = await fetch(sender.unsubscribeHttp as string, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        signal: AbortSignal.timeout(15_000),
      });
      const ok = res.ok;
      const note = ok
        ? 'désinscription en un clic acceptée'
        : `l'expéditeur a répondu ${res.status} — à refaire depuis la page`;
      await finish(ok, note);
      return {
        email: normalized,
        method,
        done: ok,
        message: ok
          ? 'Désinscription envoyée et acceptée.'
          : `L'expéditeur a répondu ${res.status}. Ouvre la page pour terminer.`,
        ...(ok ? {} : { openUrl: sender.unsubscribeHttp as string }),
      };
    } catch (err) {
      const note = `échec de la désinscription automatique : ${(err as Error).message}`;
      await finish(false, note);
      return {
        email: normalized,
        method,
        done: false,
        message: `Impossible de joindre l'expéditeur (${(err as Error).message}). Ouvre la page pour terminer.`,
        openUrl: sender.unsubscribeHttp as string,
      };
    }
  }

  if (method === 'mail') {
    const { sendEmail } = await import('./smtp.js');
    try {
      await sendEmail(rec, {
        to: [sender.unsubscribeMailto as string],
        subject: 'unsubscribe',
        text: 'unsubscribe',
      });
      await finish(true, `demande envoyée à ${sender.unsubscribeMailto}`);
      return {
        email: normalized,
        method,
        done: true,
        message: `Demande de désinscription envoyée à ${sender.unsubscribeMailto}.`,
      };
    } catch (err) {
      const note = `envoi impossible : ${(err as Error).message}`;
      await finish(false, note);
      return { email: normalized, method, done: false, message: note };
    }
  }

  // Lien seul : on ne clique pas à ta place.
  await finish(false, 'page de désinscription à ouvrir');
  return {
    email: normalized,
    method,
    done: false,
    message: "Cet expéditeur n'accepte pas la désinscription automatique — ouvre sa page.",
    openUrl: sender.unsubscribeHttp as string,
  };
}

/** Marque un expéditeur comme désinscrit à la main (après ouverture de la page). */
export async function markUnsubscribed(
  accountSlug: string,
  email: string,
): Promise<{ email: string }> {
  await ensureDbReady();
  const normalized = email.trim().toLowerCase();
  const sender = await db.sender.findUnique({
    where: { accountSlug_email: { accountSlug, email: normalized } },
    select: { id: true },
  });
  if (!sender) throw new Error(`Expéditeur inconnu de l'index : ${normalized}`);
  await db.sender.update({
    where: { id: sender.id },
    data: { unsubscribedAt: new Date(), unsubscribeNote: 'confirmé à la main' },
  });
  await recordOperation({
    account: accountSlug,
    tool: 'ui_unsubscribe_manual',
    params: { email: normalized },
    result: 'marqué désinscrit à la main',
  });
  return { email: normalized };
}
