import { config } from '../config.js';
import { logger } from '../logger.js';
import { listAccountNames, resolveAccount } from './accounts.js';
import { syncAccount } from './sync.js';
import { startJob, listJobs, type Job } from './jobs.js';

/**
 * Synchronisation automatique périodique (L5.11 — pré-requis L6 serveur 24/7).
 * SYNC_INTERVAL_MINUTES > 0 → toutes les X minutes, un job `sync-all` (mode
 * recent) est lancé SI aucun job n'est déjà en cours. Le job passe par le même
 * gestionnaire que les syncs manuelles : la pastille d'activité de l'interface
 * le suit comme les autres. 0 (défaut) = désactivé — pertinent en local, où
 * l'utilisateur synchronise à la demande.
 */

let nextRunAt: Date | null = null;

export function autoSyncStatus(): { intervalMinutes: number; nextRunAt: string | null } {
  return {
    intervalMinutes: config.sync.autoIntervalMinutes,
    nextRunAt: nextRunAt?.toISOString() ?? null,
  };
}

/**
 * Lance le job de synchronisation globale (partagé avec la route /api/sync-all).
 * L'appelant vérifie lui-même qu'aucun sync-all ne tourne déjà.
 */
export function startSyncAllJob(mode: 'recent' | 'full', names: string[]): Job {
  return startJob('sync-all', async (progress) => {
    const results: Record<string, unknown>[] = [];
    for (const name of names) {
      try {
        const rec = await resolveAccount(name);
        const r = await syncAccount(rec, {
          mode,
          onProgress: (m) => progress(`[${name}] ${m}`),
        });
        progress(`[${name}] ✅ +${r.newMessages} nouveaux, ${r.foldersSynced.length} dossiers.`);
        results.push({ account: name, newMessages: r.newMessages, errors: r.errors });
      } catch (err) {
        progress(`[${name}] ❌ ${(err as Error).message}`);
        results.push({ account: name, error: (err as Error).message });
      }
    }
    return { results };
  });
}

async function tick(): Promise<void> {
  // Ne rien empiler : si N'IMPORTE QUEL job tourne (sync manuelle, détection
  // d'échéances…), on saute ce tour — le suivant retentera.
  if (listJobs(50).some((j) => j.status === 'running')) {
    logger.info('auto-sync sautée : un job est déjà en cours');
    return;
  }
  const names = await listAccountNames();
  if (names.length === 0) return;
  logger.info('auto-sync : lancement', { accounts: names.length });
  startSyncAllJob('recent', names);
}

export function startAutoSync(): void {
  const minutes = config.sync.autoIntervalMinutes;
  if (!minutes || minutes <= 0) {
    logger.info('auto-sync désactivée (SYNC_INTERVAL_MINUTES=0)');
    return;
  }
  const ms = minutes * 60_000;
  nextRunAt = new Date(Date.now() + ms);
  const timer = setInterval(() => {
    nextRunAt = new Date(Date.now() + ms);
    tick().catch((err) => logger.warn('auto-sync : échec', { error: (err as Error).message }));
  }, ms);
  timer.unref(); // ne retient pas le process à l'arrêt
  logger.info('auto-sync activée', { intervalMinutes: minutes });
}
