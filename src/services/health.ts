import { db, ensureDbReady } from '../db/client.js';
import { config } from '../config.js';
import { listAccountNames } from './accounts.js';
import { listJobs } from './jobs.js';

/**
 * Surveillance de santé (P0.4).
 *
 * PROBLÈME TRAITÉ : « l'absence d'alerte n'est pas une preuve que tout va
 * bien ». Si un jeton expire, si Outlook refuse les connexions ou si le
 * serveur est arrêté, l'assistant se tait — et ce silence ressemble à
 * « rien à signaler ». On mesure donc la FRAÎCHEUR du travail, pas seulement
 * ses résultats.
 *
 * Signal principal : l'âge de la dernière synchronisation réussie. Il est
 * robuste par construction — quelle que soit la panne (réseau, jeton, dossier
 * illisible, process tué), la date cesse d'avancer.
 */

export type HealthLevel = 'ok' | 'warn' | 'error';

export interface AccountHealth {
  account: string;
  /** Dernière synchronisation réussie (null = jamais synchronisée). */
  lastSyncAt: string | null;
  ageHours: number | null;
  level: HealthLevel;
  /** Explication en français, affichable telle quelle. */
  message: string;
  indexedMessages: number;
  /** Mails entrants indexés mais pas encore analysés (intention/confiance). */
  unanalyzed: number;
  quotaPct: number | null;
}

export interface HealthReport {
  generatedAt: string;
  level: HealthLevel;
  /** Résumé en une ligne, prêt pour un envoi Telegram (P1). */
  summary: string;
  accounts: AccountHealth[];
  totals: {
    accounts: number;
    /** Boîtes à jour (synchro récente) — le « 9/9 » de la couverture. */
    fresh: number;
    indexedMessages: number;
    unanalyzed: number;
  };
  /** Erreurs du dernier passage de synchro encore en mémoire (best effort). */
  recentErrors: string[];
  autoSync: { enabled: boolean; intervalMinutes: number };
}

/**
 * Au-delà de quel âge une boîte est-elle « en retard » ?
 * Avec la synchro automatique : deux cycles manqués (minimum 90 min) — un
 * cycle sauté arrive normalement (un job en cours), deux non.
 * Sans synchro automatique (usage local à la demande) : 24 h, puis 72 h.
 */
function thresholds(): { warn: number; error: number } {
  const m = config.sync.autoIntervalMinutes;
  if (m > 0) {
    const warnH = Math.max((2 * m) / 60, 1.5);
    return { warn: warnH, error: warnH * 4 };
  }
  return { warn: 24, error: 72 };
}

export async function getHealth(): Promise<HealthReport> {
  await ensureDbReady();
  const { warn, error } = thresholds();
  const names = await listAccountNames();
  const rows = await db.account.findMany({
    select: {
      slug: true,
      lastSyncAt: true,
      quotaUsedBytes: true,
      quotaLimitBytes: true,
      _count: { select: { messages: true } },
    },
  });
  const bySlug = new Map(rows.map((r) => [r.slug, r]));

  // Mails entrants jamais analysés (ni intention ni confiance) — un compteur
  // qui grimpe signale un pipeline qui ne tourne plus.
  const unanalyzedRows = await db.message.groupBy({
    by: ['accountSlug'],
    where: { isDeleted: false, isOutbound: false, analysisConfidence: null },
    _count: true,
  });
  const unanalyzedBySlug = new Map(unanalyzedRows.map((r) => [r.accountSlug, r._count]));

  const accounts: AccountHealth[] = names.map((name) => {
    const row = bySlug.get(name);
    const last = row?.lastSyncAt ?? null;
    const ageHours = last ? (Date.now() - last.getTime()) / 3_600_000 : null;
    const unanalyzed = unanalyzedBySlug.get(name) ?? 0;
    const quotaPct =
      row?.quotaLimitBytes && row.quotaLimitBytes > 0n
        ? Math.round((Number(row.quotaUsedBytes ?? 0n) / Number(row.quotaLimitBytes)) * 100)
        : null;

    let level: HealthLevel = 'ok';
    let message = 'à jour';
    if (ageHours === null) {
      level = 'error';
      message = 'jamais synchronisée — lance une synchronisation';
    } else if (ageHours > error) {
      level = 'error';
      message = `pas synchronisée depuis ${fmtAge(ageHours)} — vérifie la connexion à la boîte`;
    } else if (ageHours > warn) {
      level = 'warn';
      message = `dernière synchro il y a ${fmtAge(ageHours)}`;
    } else if (quotaPct !== null && quotaPct >= 95) {
      level = 'error';
      message = `boîte pleine à ${quotaPct} % — fais du ménage`;
    } else if (quotaPct !== null && quotaPct >= 90) {
      level = 'warn';
      message = `boîte pleine à ${quotaPct} %`;
    }

    return {
      account: name,
      lastSyncAt: last ? last.toISOString() : null,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      level,
      message,
      indexedMessages: row?._count.messages ?? 0,
      unanalyzed,
      quotaPct,
    };
  });

  const fresh = accounts.filter((a) => a.level === 'ok').length;
  const level: HealthLevel = accounts.some((a) => a.level === 'error')
    ? 'error'
    : accounts.some((a) => a.level === 'warn')
      ? 'warn'
      : 'ok';

  // Erreurs du dernier job de sync encore en mémoire (perdu au redémarrage —
  // c'est bien la fraîcheur ci-dessus qui reste le signal fiable).
  const recentErrors: string[] = [];
  for (const job of listJobs(20)) {
    if (job.kind?.startsWith('sync') && job.status === 'error' && job.error) {
      recentErrors.push(`${job.kind} : ${job.error}`);
    }
  }

  const totals = {
    accounts: accounts.length,
    fresh,
    indexedMessages: accounts.reduce((s, a) => s + a.indexedMessages, 0),
    unanalyzed: accounts.reduce((s, a) => s + a.unanalyzed, 0),
  };

  const summary =
    accounts.length === 0
      ? 'Aucune boîte enrôlée.'
      : level === 'ok'
        ? `✅ ${fresh}/${accounts.length} boîtes à jour · ${totals.indexedMessages.toLocaleString('fr-FR')} mails indexés`
        : `${level === 'error' ? '🚨' : '⚠️'} ${fresh}/${accounts.length} boîtes à jour — ` +
          accounts
            .filter((a) => a.level !== 'ok')
            .map((a) => `${a.account} : ${a.message}`)
            .join(' · ');

  return {
    generatedAt: new Date().toISOString(),
    level,
    summary,
    accounts,
    totals,
    recentErrors: recentErrors.slice(0, 5),
    autoSync: {
      enabled: config.sync.autoIntervalMinutes > 0,
      intervalMinutes: config.sync.autoIntervalMinutes,
    },
  };
}

function fmtAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} jours`;
}
