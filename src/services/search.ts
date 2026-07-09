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
  /** true = mails avec pièces jointes uniquement (info posée à la sync). */
  withAttachments?: boolean;
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
  hasAttachments: boolean;
  attachmentCount: number;
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
    ...(opts.withAttachments ? { hasAttachments: true } : {}),
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
        hasAttachments: true,
        attachmentCount: true,
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
      hasAttachments: m.hasAttachments,
      attachmentCount: m.attachmentCount,
      sizeBytes: m.sizeBytes,
    })),
  };
}

export interface FolderListing {
  account: string;
  folder: string;
  total: number;
  offset: number;
  items: SearchResultItem[];
}

/**
 * Liste paginée des mails d'un dossier (L5.2 — boîte de réception navigable).
 * Index only : tri date desc, `offset`/`limit` pour la pagination, `total`
 * pour afficher « page X / Y ». Même forme d'items que la recherche.
 */
/**
 * Boîte de réception UNIFIÉE (L5.6) : les INBOX de tous les comptes, triées
 * par date décroissante, paginées. Même forme d'items que listFolderMessages
 * (chaque item porte son account/folder/uid → lecture et actions OK).
 */
export async function listUnifiedInbox(
  opts: { offset?: number; limit?: number; unseen?: boolean; withAttachments?: boolean } = {},
): Promise<FolderListing> {
  await ensureDbReady();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = {
    isDeleted: false,
    folder: { is: { role: 'inbox' } },
    ...(opts.unseen ? { isSeen: false } : {}),
    ...(opts.withAttachments ? { hasAttachments: true } : {}),
  };
  const [total, rows] = await Promise.all([
    db.message.count({ where }),
    db.message.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      skip: offset,
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
        hasAttachments: true,
        attachmentCount: true,
        sizeBytes: true,
        folder: { select: { path: true, role: true } },
      },
    }),
  ]);
  return {
    account: '',
    folder: '(toutes les boîtes)',
    total,
    offset,
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
      hasAttachments: m.hasAttachments,
      attachmentCount: m.attachmentCount,
      sizeBytes: m.sizeBytes,
    })),
  };
}

export async function listFolderMessages(
  account: string,
  folder: string,
  opts: { offset?: number; limit?: number; unseen?: boolean; withAttachments?: boolean } = {},
): Promise<FolderListing> {
  await ensureDbReady();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = {
    accountSlug: account,
    isDeleted: false,
    folder: { path: folder },
    ...(opts.unseen ? { isSeen: false } : {}),
    ...(opts.withAttachments ? { hasAttachments: true } : {}),
  };
  const [total, rows] = await Promise.all([
    db.message.count({ where }),
    db.message.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      skip: offset,
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
        hasAttachments: true,
        attachmentCount: true,
        sizeBytes: true,
        folder: { select: { path: true, role: true } },
      },
    }),
  ]);
  return {
    account,
    folder,
    total,
    offset,
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
      hasAttachments: m.hasAttachments,
      attachmentCount: m.attachmentCount,
      sizeBytes: m.sizeBytes,
    })),
  };
}

/**
 * Revalide une sélection d'UIDs contre l'index d'un dossier : ne garde que
 * les mails réellement présents, et retourne leurs sujets/dates pour le
 * journal. Garde-fou des actions en masse de l'interface.
 */
export async function validateUids(
  account: string,
  folder: string,
  uids: number[],
): Promise<{ uids: number[]; items: { subject: string; date: string | null }[] }> {
  await ensureDbReady();
  const valid: number[] = [];
  const items: { subject: string; date: string | null }[] = [];
  for (let i = 0; i < uids.length; i += 500) {
    const rows = await db.message.findMany({
      where: {
        accountSlug: account,
        isDeleted: false,
        uid: { in: uids.slice(i, i + 500) },
        folder: { path: folder },
      },
      select: { uid: true, subject: true, date: true },
    });
    for (const r of rows) {
      valid.push(r.uid);
      items.push({ subject: r.subject ?? '(sans sujet)', date: r.date?.toISOString() ?? null });
    }
  }
  return { uids: valid, items };
}

/** Variante en masse de reflectActionInIndex (une requête par lot de 500). */
export async function reflectBulkInIndex(
  account: string,
  folder: string,
  uids: number[],
  action: 'delete' | 'move' | 'seen' | 'unseen',
): Promise<void> {
  await ensureDbReady();
  const data =
    action === 'delete' || action === 'move'
      ? { isDeleted: true }
      : { isSeen: action === 'seen' };
  for (let i = 0; i < uids.length; i += 500) {
    await db.message.updateMany({
      where: { accountSlug: account, uid: { in: uids.slice(i, i + 500) }, folder: { path: folder } },
      data,
    });
  }
}

/**
 * Métadonnées d'un mail de l'index (pour journaliser les actions de l'interface
 * avec le sujet/la date exacts, et vérifier que le mail visé existe bien).
 */
export async function indexedMessage(
  account: string,
  folder: string,
  uid: number,
): Promise<{
  id: number;
  subject: string;
  date: string | null;
  isSeen: boolean;
  sizeBytes: number;
} | null> {
  await ensureDbReady();
  const m = await db.message.findFirst({
    where: { accountSlug: account, uid, isDeleted: false, folder: { path: folder } },
    select: { id: true, subject: true, date: true, isSeen: true, sizeBytes: true },
  });
  if (!m) return null;
  return {
    id: m.id,
    subject: m.subject ?? '(sans sujet)',
    date: m.date?.toISOString() ?? null,
    isSeen: m.isSeen,
    sizeBytes: m.sizeBytes,
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
