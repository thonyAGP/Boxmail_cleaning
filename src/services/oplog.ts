import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Journal des opérations d'ÉCRITURE en JSONL (SPEC §6.4).
 * Une ligne par opération : timestamp, account, tool, params, UIDs affectés.
 * Aucun secret n'est écrit (les params passés ici ne contiennent jamais de token).
 */

export interface OperationEntry {
  account: string;
  tool: string;
  params: Record<string, unknown>;
  affectedUids?: number[];
  folder?: string;
  dryRun?: boolean;
  result?: string;
}

const SENSITIVE_KEYS = /token|secret|password|authorization|bearer|cache/i;

/** Masque défensivement toute clé qui ressemblerait à un secret. */
function scrub(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '***' : v;
  }
  return out;
}

export async function recordOperation(entry: OperationEntry): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    account: entry.account,
    tool: entry.tool,
    dryRun: entry.dryRun ?? false,
    folder: entry.folder,
    params: scrub(entry.params),
    affectedUids: entry.affectedUids,
    result: entry.result,
  });
  try {
    await mkdir(dirname(config.files.operationsLog), { recursive: true });
    await appendFile(config.files.operationsLog, line + '\n');
  } catch (err) {
    // Ne pas faire échouer l'opération métier si le log échoue, mais le signaler.
    logger.error("échec écriture journal d'opérations", { error: (err as Error).message });
  }
}
