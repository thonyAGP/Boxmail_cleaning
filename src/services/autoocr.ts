/**
 * Worker OCR de fond (13/08) : la BASE est la queue.
 *
 * ~900 mails `kind='scan'` à rendre lisibles, sur un VPS à 1 seul vCPU. Ni
 * capability-fleuve (des heures rejouées à chaque boot en cas d'échec), ni
 * quota post-sync (7 boîtes qui synchronisent = CPU occupé en permanence) —
 * arbitrage de la contre-revue du 13/08. À la place : un tick périodique qui
 * traite UN document puis rend la main. Duty cycle naturel, serveur réactif,
 * et un restart pm2 ne perd rien : le sélecteur SQL (`attachmentKind='scan'`
 * et `ocrVersion` absent ou ancien) est la file persistante, les marqueurs ne
 * sont posés qu'après tentative aboutie.
 *
 * Le worker s'abstient dès qu'un job tourne (sync, backfill OCR manuel…) —
 * même règle que l'auto-sync. Quand il ne reste plus rien, chaque tick coûte
 * un COUNT SQL et rien d'autre.
 */

import { logger } from '../logger.js';
import { listAccountNames, resolveAccount } from './accounts.js';
import { ocrScansForAccount } from './attachments.js';
import { ocrDisponible, nettoyerTempOrphelins } from './ocr.js';
import { listJobs } from './jobs.js';

const TICK_MS = 2 * 60_000;

let actif = false;
let dernierResume: string | null = null;
// Round-robin des comptes : on reprend là où on s'est arrêté pour que les
// petites boîtes ne passent pas toujours derrière la grosse.
let prochainCompte = 0;

export function autoOcrStatus(): { actif: boolean; dernierResume: string | null } {
  return { actif, dernierResume };
}

async function tick(): Promise<void> {
  if (listJobs(50).some((j) => j.status === 'running')) return;
  const dispo = await ocrDisponible();
  if (!dispo.ok) return; // rien à faire tant que l'apt install n'est pas passé

  const noms = await listAccountNames();
  if (noms.length === 0) return;

  // Un SEUL document par tick, en cherchant à partir du compte suivant le
  // dernier servi. Un compte sans scan éligible ne coûte qu'un COUNT.
  for (let i = 0; i < noms.length; i++) {
    const nom = noms[(prochainCompte + i) % noms.length];
    let rec;
    try {
      rec = await resolveAccount(nom);
    } catch {
      continue;
    }
    const r = await ocrScansForAccount(rec, { limit: 1 });
    if (r.scanned === 0) continue;
    prochainCompte = (prochainCompte + i + 1) % noms.length;
    dernierResume =
      `${nom} : ` +
      (r.ocred
        ? `1 scan devenu lisible${r.requeued ? ', renvoyé à l’analyse' : ''}`
        : r.illisibles
          ? '1 scan illisible même à la machine'
          : '1 échec technique, sera repris') +
      ` — ${r.remaining} restant(s) sur ce compte.`;
    logger.info('ocr de fond', { account: nom, ocred: r.ocred, illisibles: r.illisibles, failures: r.failures, remaining: r.remaining });
    return;
  }
}

export function startAutoOcr(): void {
  if (actif) return;
  actif = true;
  // Des pages de factures ne doivent pas traîner dans /tmp après un crash.
  nettoyerTempOrphelins().catch(() => {});
  const timer = setInterval(() => {
    tick().catch((err) => logger.warn('ocr de fond : échec', { error: (err as Error).message }));
  }, TICK_MS);
  timer.unref(); // ne retient pas le process à l'arrêt
  logger.info('worker OCR de fond activé', { intervalMinutes: TICK_MS / 60_000 });
}
