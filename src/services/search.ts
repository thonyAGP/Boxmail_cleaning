import { db, ensureDbReady } from '../db/client.js';

/**
 * Recherche de mails dans l'INDEX local (L3). Métadonnées uniquement : aucune
 * connexion IMAP, aucune lecture de contenu — instantané même sur des dizaines
 * de milliers de mails. La lecture du corps d'un mail précis passe par
 * imapService.readEmail (route dédiée), jamais par un LLM.
 */

export interface SearchOptions {
  /** Texte libre : OR sur sujet, adresse et nom d'expéditeur. */
  q?: string;
  /** Restreindre à un compte (slug) ; absent = tous les comptes indexés. */
  account?: string;
  /** Restreindre à un dossier (chemin exact, ex. INBOX). */
  folder?: string;
  /** Filtre expéditeur (fragment d'adresse ou de nom). */
  from?: string;
  /** Filtre sujet (fragment). */
  subject?: string;
  /** Mails reçus après cette date. */
  since?: Date;
  /** Mails reçus avant cette date. */
  before?: Date;
  /** true = non lus uniquement. */
  unseen?: boolean;
  limit?: number;
}

export interface SearchResultItem {
  account: string;
  folder: string;
  folderRole: string;
  uid: number;
  messageId: number;
  threadId: number | null;
  subject: string;
  fromName: string;
  fromEmail: string;
  date: string | null;
  isSeen: boolean;
  isOutbound: boolean;
  hasListUnsubscribe: boolean;
  sizeBytes: number;
}

export interface SearchResult {
  total: number;
  truncated: boolean;
  items: SearchResultItem[];
}

/** Recherche métadata dans l'index, tous comptes si `account` absent. */
export async function searchIndex(opts: SearchOptions): Promise<SearchResult> {
  await ensureDbReady();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const and: Record<string, unknown>[] = [];
  const q = opts.q?.trim();
  if (q) {
    and.push({
      OR: [
        { subject: { contains: q } },
        { fromEmail: { contains: q.toLowerCase() } },
        { fromName: { contains: q } },
      ],
    });
  }
  const from = opts.from?.trim();
  if (from) {
    and.push({
      OR: [{ fromEmail: { contains: from.toLowerCase() } }, { fromName: { contains: from } }],
    });
  }
  const subject = opts.subject?.trim();
  if (subject) and.push({ subject: { contains: subject } });

  const where = {
    isDeleted: false,
    ...(opts.account ? { accountSlug: opts.account } : {}),
    ...(opts.folder ? { folder: { path: opts.folder } } : {}),
    ...(opts.unseen ? { isSeen: false } : {}),
    ...(opts.since || opts.before
      ? {
          date: {
            ...(opts.since ? { gte: opts.since } : {}),
            ...(opts.before ? { lte: opts.before } : {}),
          },
        }
      : {}),
    ...(and.length ? { AND: and } : {}),
  };

  const [total, rows] = await Promise.all([
    db.message.count({ where }),
    db.message.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        accountSlug: true,
        uid: true,
        threadId: true,
        subject: true,
        fromName: true,
        fromEmail: true,
        date: true,
        isSeen: true,
        isOutbound: true,
        hasListUnsubscribe: true,
        sizeBytes: true,
        folder: { select: { path: true, role: true } },
      },
    }),
  ]);

  return {
    total,
    truncated: total > rows.length,
    items: rows.map((m) => ({
      account: m.accountSlug,
      folder: m.folder.path,
      folderRole: m.folder.role,
      uid: m.uid,
      messageId: m.id,
      threadId: m.threadId,
      subject: m.subject ?? '(sans sujet)',
      fromName: m.fromName ?? '',
      fromEmail: m.fromEmail ?? '',
      date: m.date?.toISOString() ?? null,
      isSeen: m.isSeen,
      isOutbound: m.isOutbound,
      hasListUnsubscribe: m.hasListUnsubscribe,
      sizeBytes: m.sizeBytes,
    })),
  };
}

/**
 * Métadonnées d'un mail de l'index (pour journaliser les actions de l'interface
 * avec le sujet/la date exacts, et vérifier que le mail visé existe bien).
 */
export async function indexedMessage(
  account: string,
  folder: string,
  uid: number,
): Promise<{ id: number; subject: string; date: string | null; isSeen: boolean } | null> {
  await ensureDbReady();
  const m = await db.message.findFirst({
    where: { accountSlug: account, uid, isDeleted: false, folder: { path: folder } },
    select: { id: true, subject: true, date: true, isSeen: true },
  });
  if (!m) return null;
  return {
    id: m.id,
    subject: m.subject ?? '(sans sujet)',
    date: m.date?.toISOString() ?? null,
    isSeen: m.isSeen,
  };
}

/**
 * Répercute dans l'index une action faite via l'interface, sans attendre la
 * prochaine sync : suppression (soft) → isDeleted, lu/non lu → isSeen.
 * L'index reste un cache : la sync suivante réconcilie l'état réel.
 */
export async function reflectActionInIndex(
  account: string,
  folder: string,
  uid: number,
  action: 'delete' | 'move' | 'seen' | 'unseen',
): Promise<void> {
  await ensureDbReady();
  const data =
    action === 'delete' || action === 'move'
      ? { isDeleted: true }
      : { isSeen: action === 'seen' };
  await db.message.updateMany({
    where: { accountSlug: account, uid, folder: { path: folder } },
    data,
  });
}
