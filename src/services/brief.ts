import { db, ensureDbReady } from '../db/client.js';
import { listAccountNames } from './accounts.js';
import { getOverdueReplies } from './attention.js';
import { getFollowupsDue } from './followups.js';
import { getImportantEmails, type ImportantItem } from './importance.js';
import { listDeadlines, type DeadlineItem } from './deadlines.js';
import { getCleanupCandidates } from './cleanup.js';
import { listTasks, type TaskItem } from './tasks.js';
import { logger } from '../logger.js';

/**
 * Brief Engine — Phase 8 (L5) : BRIEF QUOTIDIEN & REVUE HEBDO (SPEC V2 §8.1).
 *
 * Agrège en un seul JSON structuré tout ce que les briques précédentes savent
 * déjà calculer (index local uniquement, aucun accès IMAP) : nouveaux mails,
 * mails importants, réponses en attente, relances, échéances proches,
 * nettoyage possible, volumétrie par compte. Le JSON est prêt à être NARRÉ en
 * français par Claude (via MCP) ou affiché par l'interface.
 *
 * Chaque brief généré est sauvegardé dans BriefRun : le suivant peut ainsi
 * dire « depuis le dernier brief » en plus de la fenêtre fixe (24 h / 7 j).
 */

export type BriefType = 'daily' | 'weekly';

export interface BriefAccountSummary {
  account: string;
  emailAddress: string;
  lastSyncAt: string | null;
  inbox: { messages: number; unseen: number };
  /** Mails entrants indexés arrivés pendant la période du brief. */
  newMessages: number;
}

export interface Brief {
  type: BriefType;
  /** Libellé humain de la période (« dernières 24 h », « 7 derniers jours »). */
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  /** Brief précédent du même type (pour « depuis le dernier brief »), sinon null. */
  previousBrief: { at: string; newMessagesSince: number } | null;
  totals: {
    accounts: number;
    /** Entrants indexés pendant la période, tous comptes. */
    newMessages: number;
    unseenInbox: number;
  };
  accounts: BriefAccountSummary[];
  important: { high: number; medium: number; top: ImportantItem[] };
  replies: { overdue: number; top: OverdueSummary[] };
  followups: { overdue: number; top: FollowupSummary[] };
  deadlines: { upcoming: number; toValidate: number; items: DeadlineItem[] };
  /** Tâches à faire (L5.5) — absent des briefs archivés avant cette version. */
  tasks: { todo: number; overdue: number; top: TaskItem[] };
  cleanup: { deletableEstimate: number; topSenders: CleanupSummary[] };
  /** Comptes ignorés (non indexés…) avec la raison — le brief reste utilisable. */
  skippedAccounts: { account: string; error: string }[];
}

export interface OverdueSummary {
  account: string;
  threadId: number;
  folder: string;
  uid: number;
  isSeen: boolean;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  date: string;
  waitingHours: number;
  categoryLabel: string;
  reason: string;
}

export interface FollowupSummary {
  account: string;
  threadId: number;
  folder: string;
  uid: number;
  counterpartyEmail: string;
  counterpartyName: string | null;
  subject: string;
  date: string;
  waitingHours: number;
  reason: string;
}

export interface CleanupSummary {
  account: string;
  sender: string;
  senderName: string;
  messageCount: number;
  totalSizeBytes: number;
}

export interface GenerateBriefOptions {
  type?: BriefType;
  /** Comptes à couvrir (défaut : tous les comptes enrôlés). */
  accounts?: string[];
  /** Nombre d'éléments détaillés par rubrique (défaut 5, max 20). */
  topLimit?: number;
}

const WINDOW_HOURS: Record<BriefType, number> = { daily: 24, weekly: 7 * 24 };
const PERIOD_LABELS: Record<BriefType, string> = {
  daily: 'dernières 24 heures',
  weekly: '7 derniers jours',
};

/** Fenêtre des mails importants : plus large que la période (un mail important
 *  de la semaine passée reste important tant qu'il n'est pas lu). */
const IMPORTANT_SINCE_DAYS: Record<BriefType, number> = { daily: 7, weekly: 30 };

const DEADLINE_HORIZON_DAYS = 14;

/**
 * Génère le brief (JSON structuré) et l'enregistre dans BriefRun.
 * Index local uniquement : instantané, aucune connexion IMAP.
 */
export async function generateBrief(opts: GenerateBriefOptions = {}): Promise<Brief> {
  await ensureDbReady();
  const type: BriefType = opts.type === 'weekly' ? 'weekly' : 'daily';
  const topLimit = Math.min(Math.max(opts.topLimit ?? 5, 1), 20);
  const now = new Date();
  const periodStart = new Date(now.getTime() - WINDOW_HOURS[type] * 3_600_000);

  const names = opts.accounts?.length ? opts.accounts : await listAccountNames();

  // Brief précédent du même type (avant d'enregistrer celui-ci).
  const prevRun = await db.briefRun.findFirst({
    where: { type },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  const accounts: BriefAccountSummary[] = [];
  const skippedAccounts: { account: string; error: string }[] = [];
  const importantAll: ImportantItem[] = [];
  let importantHigh = 0;
  let importantMedium = 0;
  const repliesTop: OverdueSummary[] = [];
  let repliesOverdue = 0;
  const followupsTop: FollowupSummary[] = [];
  let followupsOverdue = 0;
  const deadlinesAll: DeadlineItem[] = [];
  const cleanupTop: CleanupSummary[] = [];
  let deletableEstimate = 0;
  let newMessagesSincePrev = 0;

  for (const name of names) {
    try {
      const acc = await db.account.findUnique({ where: { slug: name } });
      if (!acc) throw new Error('compte non indexé — lancer une synchronisation');

      // Volumétrie : boîte de réception (compteurs tenus par la sync).
      const inboxFolder = await db.folder.findFirst({
        where: { accountSlug: name, role: 'inbox' },
        select: { messageCount: true, unseenCount: true },
      });

      // « Nouveaux mails » : entrants indexés pendant la période. Approximation
      // par Message.createdAt (date d'indexation) — fidèle dès que les syncs
      // sont régulières, et robuste aux mails antidatés.
      const newMessages = await db.message.count({
        where: {
          accountSlug: name,
          isDeleted: false,
          isOutbound: false,
          createdAt: { gte: periodStart },
          folder: { is: { role: { notIn: ['trash', 'spam', 'drafts'] } } },
        },
      });
      if (prevRun) {
        newMessagesSincePrev += await db.message.count({
          where: {
            accountSlug: name,
            isDeleted: false,
            isOutbound: false,
            createdAt: { gte: prevRun.createdAt },
            folder: { is: { role: { notIn: ['trash', 'spam', 'drafts'] } } },
          },
        });
      }

      accounts.push({
        account: name,
        emailAddress: acc.emailAddress,
        lastSyncAt: acc.lastSyncAt?.toISOString() ?? null,
        inbox: {
          messages: inboxFolder?.messageCount ?? 0,
          unseen: inboxFolder?.unseenCount ?? 0,
        },
        newMessages,
      });

      // Mails importants (L1) : minScore 60, non lus.
      const imp = await getImportantEmails(name, {
        sinceDays: IMPORTANT_SINCE_DAYS[type],
        minScore: 60,
        limit: 50,
      });
      importantHigh += imp.counts.high;
      importantMedium += imp.counts.medium;
      importantAll.push(...imp.items);

      // Réponses en attente en retard (brique 1).
      const rep = await getOverdueReplies(name, { sinceDays: 60, limit: 50 });
      repliesOverdue += rep.counts.overdue;
      repliesTop.push(
        ...rep.items
          .filter((i) => i.state === 'active' && i.overdue)
          .map((i) => ({
            account: i.account,
            threadId: i.threadId,
            folder: i.folder,
            uid: i.uid,
            isSeen: i.isSeen,
            fromEmail: i.fromEmail,
            fromName: i.fromName,
            subject: i.subject,
            date: i.date,
            waitingHours: i.waitingHours,
            categoryLabel: i.categoryLabel,
            reason: i.reason,
          })),
      );

      // Relances en retard (brique 2).
      const fu = await getFollowupsDue(name, { scope: 'overdue', sinceDays: 60, limit: 50 });
      followupsOverdue += fu.counts.overdue;
      followupsTop.push(
        ...fu.items
          .filter((i) => i.state === 'active' && i.overdue)
          .map((i) => ({
            account: i.account,
            threadId: i.threadId,
            folder: i.folder,
            uid: i.uid,
            counterpartyEmail: i.counterpartyEmail,
            counterpartyName: i.counterpartyName,
            subject: i.subject,
            date: i.date,
            waitingHours: i.waitingHours,
            reason: i.reason,
          })),
      );

      // Échéances < 14 j (L2) : proposées + confirmées, y compris hier (retard frais).
      const dls = await listDeadlines(name, {
        fromDate: new Date(now.getTime() - 86_400_000).toISOString(),
        toDate: new Date(now.getTime() + DEADLINE_HORIZON_DAYS * 86_400_000).toISOString(),
        limit: 100,
      });
      deadlinesAll.push(
        ...dls.filter((d) => d.status === 'proposed' || d.status === 'confirmed'),
      );

      // Nettoyage possible (existant).
      const cl = await getCleanupCandidates(name);
      deletableEstimate += cl.totalDeletableEstimate;
      cleanupTop.push(
        ...cl.candidates.slice(0, topLimit).map((c) => ({
          account: name,
          sender: c.sender,
          senderName: c.senderName,
          messageCount: c.messageCount,
          totalSizeBytes: c.totalSizeBytes,
        })),
      );
    } catch (err) {
      skippedAccounts.push({ account: name, error: (err as Error).message });
      logger.warn('brief : compte ignoré', { account: name, error: (err as Error).message });
    }
  }

  // Tâches (globales, pas par compte).
  let tasks: Brief['tasks'] = { todo: 0, overdue: 0, top: [] };
  try {
    const t = await listTasks({ limit: 200 });
    tasks = {
      todo: t.counts.todo,
      overdue: t.counts.overdue,
      top: t.items.filter((i) => i.status === 'todo').slice(0, topLimit),
    };
  } catch (err) {
    logger.warn('brief : tâches indisponibles', { error: (err as Error).message });
  }

  importantAll.sort((a, b) => b.score - a.score);
  repliesTop.sort((a, b) => b.waitingHours - a.waitingHours);
  followupsTop.sort((a, b) => b.waitingHours - a.waitingHours);
  deadlinesAll.sort((a, b) => a.date.localeCompare(b.date));
  cleanupTop.sort((a, b) => b.messageCount - a.messageCount);

  const brief: Brief = {
    type,
    periodLabel: PERIOD_LABELS[type],
    periodStart: periodStart.toISOString(),
    periodEnd: now.toISOString(),
    generatedAt: now.toISOString(),
    previousBrief: prevRun
      ? { at: prevRun.createdAt.toISOString(), newMessagesSince: newMessagesSincePrev }
      : null,
    totals: {
      accounts: accounts.length,
      newMessages: accounts.reduce((s, a) => s + a.newMessages, 0),
      unseenInbox: accounts.reduce((s, a) => s + a.inbox.unseen, 0),
    },
    accounts,
    important: { high: importantHigh, medium: importantMedium, top: importantAll.slice(0, topLimit) },
    replies: { overdue: repliesOverdue, top: repliesTop.slice(0, topLimit) },
    followups: { overdue: followupsOverdue, top: followupsTop.slice(0, topLimit) },
    deadlines: {
      upcoming: deadlinesAll.length,
      toValidate: deadlinesAll.filter((d) => d.status === 'proposed').length,
      items: deadlinesAll.slice(0, Math.max(topLimit, 10)),
    },
    tasks,
    cleanup: { deletableEstimate, topSenders: cleanupTop.slice(0, topLimit) },
    skippedAccounts,
  };

  await db.briefRun.create({
    data: {
      type,
      periodStart,
      periodEnd: now,
      summaryJson: JSON.stringify(brief),
    },
  });

  return brief;
}

/** Dernier brief enregistré du type demandé (null si jamais généré). */
export async function latestBrief(type: BriefType): Promise<Brief | null> {
  await ensureDbReady();
  const run = await db.briefRun.findFirst({
    where: { type },
    orderBy: { createdAt: 'desc' },
  });
  if (!run) return null;
  try {
    return JSON.parse(run.summaryJson) as Brief;
  } catch {
    return null;
  }
}
