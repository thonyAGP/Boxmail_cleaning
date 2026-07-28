import { db, ensureDbReady } from '../db/client.js';
import { recordOperation } from './oplog.js';

/**
 * Tâches (L5.5) : la liste « à faire » de l'utilisateur, alimentée à la main,
 * depuis un mail (panneau de lecture) ou depuis une échéance. État local
 * uniquement — ne touche jamais aux mails. Tout changement est journalisé.
 */

export type TaskStatus = 'todo' | 'done' | 'dismissed';
export type TaskSource = 'manual' | 'mail' | 'deadline';

export interface TaskItem {
  id: number;
  title: string;
  notes: string | null;
  dueDate: string | null;
  status: TaskStatus;
  source: TaskSource;
  account: string | null;
  /** Mail d'origine (pour l'ouvrir depuis l'écran), null si tâche manuelle. */
  subject: string | null;
  fromEmail: string | null;
  fromName: string | null;
  folder: string | null;
  uid: number | null;
  /** Jours restants (négatif si en retard) — null sans date. */
  inDays: number | null;
  overdue: boolean;
  createdAt: string;
  doneAt: string | null;
}

export interface TasksResult {
  counts: { todo: number; overdue: number; done: number; dismissed: number };
  items: TaskItem[];
}

type TaskRow = {
  id: number;
  title: string;
  notes: string | null;
  dueDate: Date | null;
  status: string;
  source: string;
  accountSlug: string | null;
  subject: string | null;
  fromEmail: string | null;
  fromName: string | null;
  folder: string | null;
  uid: number | null;
  createdAt: Date;
  doneAt: Date | null;
};

function toItem(t: TaskRow): TaskItem {
  const inDays =
    t.dueDate !== null ? Math.round((t.dueDate.getTime() - Date.now()) / 86_400_000) : null;
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    dueDate: t.dueDate?.toISOString() ?? null,
    status: t.status as TaskStatus,
    source: t.source as TaskSource,
    account: t.accountSlug,
    subject: t.subject,
    fromEmail: t.fromEmail,
    fromName: t.fromName,
    folder: t.folder,
    uid: t.uid,
    inDays,
    overdue: t.status === 'todo' && inDays !== null && inDays < 0,
    createdAt: t.createdAt.toISOString(),
    doneAt: t.doneAt?.toISOString() ?? null,
  };
}

/** Toutes les tâches (avec compteurs), à faire d'abord, échéance proche en tête. */
export async function listTasks(opts: { limit?: number } = {}): Promise<TasksResult> {
  await ensureDbReady();
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  const rows = await db.task.findMany({
    orderBy: [{ createdAt: 'desc' }],
    take: limit,
  });
  const items = rows.map(toItem);
  items.sort((a, b) => {
    const rank = (s: string) => (s === 'todo' ? 0 : s === 'done' ? 1 : 2);
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    // À faire : datées d'abord (les plus proches en tête), puis sans date.
    if (a.status === 'todo') {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
  return {
    counts: {
      todo: items.filter((i) => i.status === 'todo').length,
      overdue: items.filter((i) => i.overdue).length,
      done: items.filter((i) => i.status === 'done').length,
      dismissed: items.filter((i) => i.status === 'dismissed').length,
    },
    items,
  };
}

export interface CreateTaskInput {
  title: string;
  notes?: string;
  dueDate?: Date | null;
  account?: string | null;
  /** Mail d'origine : la tâche garde un lien cliquable vers lui. */
  messageRef?: { folder: string; uid: number } | null;
  source?: TaskSource;
}

export async function createTask(input: CreateTaskInput): Promise<TaskItem> {
  await ensureDbReady();
  const title = input.title.trim().slice(0, 300);
  if (!title) throw new Error('Le titre de la tâche est requis.');
  if (input.dueDate && Number.isNaN(input.dueDate.getTime())) throw new Error('Date invalide.');

  let msg: {
    id: number;
    subject: string | null;
    fromEmail: string | null;
    fromName: string | null;
  } | null = null;
  let folder: string | null = null;
  let uid: number | null = null;
  if (input.messageRef && input.account) {
    msg = await db.message.findFirst({
      where: {
        accountSlug: input.account,
        uid: input.messageRef.uid,
        isDeleted: false,
        folder: { path: input.messageRef.folder },
      },
      select: { id: true, subject: true, fromEmail: true, fromName: true },
    });
    if (msg) {
      folder = input.messageRef.folder;
      uid = input.messageRef.uid;
    }
  }

  const row = await db.task.create({
    data: {
      title,
      notes: input.notes?.trim().slice(0, 2000) || null,
      dueDate: input.dueDate ?? null,
      source: input.source ?? (msg ? 'mail' : 'manual'),
      accountSlug: input.account ?? null,
      messageId: msg?.id ?? null,
      subject: msg?.subject ?? null,
      fromEmail: msg?.fromEmail ?? null,
      fromName: msg?.fromName ?? null,
      folder,
      uid,
    },
  });
  await recordOperation({
    account: input.account ?? 'global',
    tool: 'create_task',
    params: { taskId: row.id, title, dueDate: row.dueDate?.toISOString() ?? null, source: row.source },
    items: [
      {
        subject: title,
        date: row.dueDate?.toISOString() ?? null,
        ...(folder && uid ? { folder, uid } : {}),
      },
    ],
    result: 'tâche créée',
  });
  return toItem(row);
}

/** Crée une tâche depuis une échéance (titre + date repris de l'échéance). */
export async function taskFromDeadline(account: string, deadlineId: number): Promise<TaskItem> {
  await ensureDbReady();
  const d = await db.deadline.findFirst({ where: { id: deadlineId, accountSlug: account } });
  if (!d) throw new Error(`Échéance ${deadlineId} introuvable pour le compte « ${account} ».`);
  const existing = await db.task.findFirst({
    where: { deadlineId, status: { not: 'dismissed' } },
  });
  if (existing) return toItem(existing);

  const msg = await db.message.findFirst({
    where: { id: d.messageId, accountSlug: account, isDeleted: false },
    select: { uid: true, folder: { select: { path: true } } },
  });
  const row = await db.task.create({
    data: {
      title: d.title,
      dueDate: d.date,
      source: 'deadline',
      accountSlug: account,
      messageId: d.messageId,
      deadlineId,
      subject: d.subject,
      fromEmail: d.fromEmail,
      fromName: d.fromName,
      folder: msg?.folder.path ?? null,
      uid: msg?.uid ?? null,
    },
  });
  await recordOperation({
    account,
    tool: 'task_from_deadline',
    params: { taskId: row.id, deadlineId, dueDate: d.date.toISOString() },
    items: [
      {
        subject: d.title,
        date: d.date.toISOString(),
        ...(msg ? { folder: msg.folder.path, uid: msg.uid } : {}),
      },
    ],
    result: 'tâche créée depuis une échéance',
  });
  return toItem(row);
}

async function setTaskStatus(
  id: number,
  status: TaskStatus,
  toolName: string,
  resultLabel: string,
): Promise<TaskItem> {
  await ensureDbReady();
  const row = await db.task.findUnique({ where: { id } });
  if (!row) throw new Error(`Tâche ${id} introuvable.`);
  const updated = await db.task.update({
    where: { id },
    data: { status, doneAt: status === 'done' ? new Date() : null },
  });
  await recordOperation({
    account: row.accountSlug ?? 'global',
    tool: toolName,
    params: { taskId: id },
    items: [
      {
        subject: row.title,
        date: row.dueDate?.toISOString() ?? null,
        ...(row.folder && row.uid ? { folder: row.folder, uid: row.uid } : {}),
      },
    ],
    result: resultLabel,
  });
  return toItem(updated);
}

export function completeTask(id: number): Promise<TaskItem> {
  return setTaskStatus(id, 'done', 'complete_task', 'tâche terminée');
}

export function dismissTask(id: number): Promise<TaskItem> {
  return setTaskStatus(id, 'dismissed', 'dismiss_task', 'tâche ignorée');
}

export function reopenTask(id: number): Promise<TaskItem> {
  return setTaskStatus(id, 'todo', 'reopen_task', 'tâche rouverte');
}
