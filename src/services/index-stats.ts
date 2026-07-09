import { db, ensureDbReady } from '../db/client.js';
import type { SenderStat } from './imap.js';

/**
 * Requêtes de lecture sur l'index persistant (SQLite). Instantanées même sur
 * des dizaines de milliers de mails, contrairement aux scans IMAP live.
 */

/** L'index couvre-t-il ce dossier ? (compte synchronisé + dossier indexé) */
export async function isFolderIndexed(account: string, folder: string): Promise<boolean> {
  try {
    await ensureDbReady();
  } catch {
    return false;
  }
  const f = await db.folder.findUnique({
    where: { accountSlug_path: { accountSlug: account, path: folder } },
    select: { lastSyncedAt: true },
  });
  return f?.lastSyncedAt != null;
}

export async function lastSyncAt(account: string): Promise<string | null> {
  try {
    await ensureDbReady();
  } catch {
    return null;
  }
  const acc = await db.account.findUnique({
    where: { slug: account },
    select: { lastSyncAt: true },
  });
  return acc?.lastSyncAt?.toISOString() ?? null;
}

/** Équivalent index de getSenderStats — groupBy SQL sur le dossier. */
export async function senderStatsFromIndex(
  account: string,
  folder: string,
  limit: number,
  since?: string,
): Promise<{ totalMessages: number; senders: SenderStat[] }> {
  await ensureDbReady();
  const f = await db.folder.findUnique({
    where: { accountSlug_path: { accountSlug: account, path: folder } },
    select: { id: true },
  });
  if (!f) throw new Error(`Dossier "${folder}" absent de l'index.`);

  const where = {
    folderId: f.id,
    isDeleted: false,
    fromEmail: { not: null },
    ...(since ? { date: { gte: new Date(since) } } : {}),
  };

  const [total, groups, unsubGroups, names] = await Promise.all([
    db.message.count({ where }),
    db.message.groupBy({
      by: ['fromEmail'],
      where,
      _count: { _all: true },
      _sum: { sizeBytes: true },
      _max: { date: true },
      orderBy: { _count: { fromEmail: 'desc' } },
      take: limit,
    }),
    db.message.groupBy({
      by: ['fromEmail'],
      where: { ...where, hasListUnsubscribe: true },
      _count: { _all: true },
    }),
    db.sender.findMany({
      where: { accountSlug: account },
      select: { email: true, displayName: true },
    }),
  ]);

  const unsubByEmail = new Map(unsubGroups.map((g) => [g.fromEmail, g._count._all]));
  const nameByEmail = new Map(names.map((n) => [n.email, n.displayName ?? '']));

  const senders: SenderStat[] = groups.map((g) => {
    const email = g.fromEmail as string;
    const count = g._count._all;
    const unsub = unsubByEmail.get(email) ?? 0;
    return {
      address: email,
      name: nameByEmail.get(email) ?? '',
      count,
      latestDate: g._max.date?.toISOString() ?? null,
      totalSizeBytes: g._sum.sizeBytes ?? 0,
      unsubscribeCount: unsub,
      unsubscribePct: count ? Math.round((unsub / count) * 100) : 0,
    };
  });

  return { totalMessages: total, senders };
}

export interface MailboxOverview {
  account: string;
  emailAddress: string;
  lastSyncAt: string | null;
  indexedMessages: number;
  folders: {
    path: string;
    role: string;
    messageCount: number;
    unseenCount: number;
  }[];
  inbox: {
    messages: number;
    unseen: number;
    newsletters: number;
    totalSizeBytes: number;
  } | null;
  topSenders: { address: string; name: string; count: number; unsubscribePct: number }[];
  senderCount: number;
}

/** Vue d'ensemble d'un compte depuis l'index (SPEC V2 get_mailbox_overview). */
export async function mailboxOverview(account: string): Promise<MailboxOverview> {
  await ensureDbReady();
  const acc = await db.account.findUnique({ where: { slug: account } });
  if (!acc) {
    throw new Error(
      `Compte "${account}" non indexé. Lancer d'abord sync_account (ou npm run sync -- --account ${account}).`,
    );
  }

  const folders = await db.folder.findMany({
    where: { accountSlug: account },
    orderBy: { path: 'asc' },
    select: { id: true, path: true, role: true, messageCount: true, unseenCount: true },
  });

  const inboxFolder = folders.find((f) => f.role === 'inbox');
  let inbox: MailboxOverview['inbox'] = null;
  if (inboxFolder) {
    const where = { folderId: inboxFolder.id, isDeleted: false };
    const [newsletters, size] = await Promise.all([
      db.message.count({ where: { ...where, hasListUnsubscribe: true } }),
      db.message.aggregate({ where, _sum: { sizeBytes: true } }),
    ]);
    inbox = {
      messages: inboxFolder.messageCount,
      unseen: inboxFolder.unseenCount,
      newsletters,
      totalSizeBytes: size._sum.sizeBytes ?? 0,
    };
  }

  const [indexedMessages, senderCount, topSenders] = await Promise.all([
    db.message.count({ where: { accountSlug: account, isDeleted: false } }),
    db.sender.count({ where: { accountSlug: account, messageCount: { gt: 0 } } }),
    db.sender.findMany({
      where: { accountSlug: account, messageCount: { gt: 0 } },
      orderBy: { messageCount: 'desc' },
      take: 5,
      select: {
        email: true,
        displayName: true,
        messageCount: true,
        unsubscribeCount: true,
      },
    }),
  ]);

  return {
    account,
    emailAddress: acc.emailAddress,
    lastSyncAt: acc.lastSyncAt?.toISOString() ?? null,
    indexedMessages,
    folders: folders.map(({ id: _id, ...rest }) => rest),
    inbox,
    topSenders: topSenders.map((s) => ({
      address: s.email,
      name: s.displayName ?? '',
      count: s.messageCount,
      unsubscribePct: s.messageCount
        ? Math.round((s.unsubscribeCount / s.messageCount) * 100)
        : 0,
    })),
    senderCount,
  };
}

/** Vue globale tous comptes indexés (SPEC V2 get_global_overview). */
export async function globalOverview(): Promise<{
  accounts: MailboxOverview[];
  totals: { accounts: number; indexedMessages: number; unseenInbox: number };
}> {
  await ensureDbReady();
  const accounts = await db.account.findMany({ select: { slug: true } });
  const overviews: MailboxOverview[] = [];
  for (const a of accounts) {
    overviews.push(await mailboxOverview(a.slug));
  }
  return {
    accounts: overviews,
    totals: {
      accounts: overviews.length,
      indexedMessages: overviews.reduce((s, o) => s + o.indexedMessages, 0),
      unseenInbox: overviews.reduce((s, o) => s + (o.inbox?.unseen ?? 0), 0),
    },
  };
}
