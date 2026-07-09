import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';

/**
 * Gestionnaire de tâches longues en mémoire (ex. synchronisation d'un compte
 * lancée depuis l'interface web). L'appelant crée un job, reçoit un id, et le
 * frontend interroge /api/jobs/:id pour suivre la progression.
 */

export interface Job {
  id: string;
  kind: string;
  status: 'running' | 'done' | 'error';
  progress: string[];
  /** Données structurées exposées par le job (ex. code device flow). */
  meta: Record<string, unknown>;
  result: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const jobs = new Map<string, Job>();
const MAX_JOBS = 50;

function gc(): void {
  if (jobs.size <= MAX_JOBS) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''));
  for (const j of finished.slice(0, jobs.size - MAX_JOBS)) jobs.delete(j.id);
}

export function startJob(
  kind: string,
  run: (
    progress: (message: string) => void,
    setMeta: (data: Record<string, unknown>) => void,
  ) => Promise<unknown>,
): Job {
  const job: Job = {
    id: randomUUID(),
    kind,
    status: 'running',
    progress: [],
    meta: {},
    result: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  gc();

  void run(
    (message) => {
      job.progress.push(message);
      if (job.progress.length > 200) job.progress.splice(0, job.progress.length - 200);
    },
    (data) => {
      Object.assign(job.meta, data);
    },
  )
    .then((result) => {
      job.status = 'done';
      job.result = result;
      job.finishedAt = new Date().toISOString();
    })
    .catch((err) => {
      job.status = 'error';
      job.error = (err as Error).message;
      job.finishedAt = new Date().toISOString();
      logger.warn('job en échec', { kind, error: job.error });
    });

  return job;
}

export function getJob(id: string): Job | null {
  return jobs.get(id) ?? null;
}

/** Un job de ce type est-il déjà en cours ? (évite les syncs concurrentes) */
export function hasRunningJob(kind: string): boolean {
  return [...jobs.values()].some((j) => j.kind === kind && j.status === 'running');
}
