import { PrismaClient } from '@prisma/client';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../logger.js';

/**
 * Client Prisma singleton (SQLite).
 *
 * Le chemin SQLite relatif de DATABASE_URL est résolu par Prisma par rapport à
 * prisma/schema.prisma ; si la variable est absente, on la fixe ici vers
 * <racine>/data/boxmail.db pour que tout fonctionne sans configuration.
 */

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
  process.env.DATABASE_URL = 'file:../data/boxmail.db';
}

// Une seule connexion SQLite : toutes les écritures se sérialisent proprement,
// même quand plusieurs jobs (syncs de comptes différents) tournent en parallèle
// — sinon risque de SQLITE_BUSY sous contention.
if (!/connection_limit=/.test(process.env.DATABASE_URL)) {
  process.env.DATABASE_URL +=
    (process.env.DATABASE_URL.includes('?') ? '&' : '?') + 'connection_limit=1';
}

// S'assure que le dossier data/ existe (SQLite ne crée pas les dossiers).
try {
  mkdirSync(resolve(process.cwd(), 'data'), { recursive: true });
} catch {
  /* ignore */
}

export const db = new PrismaClient();

/**
 * Vérifie que la base est migrée. À appeler avant les opérations d'index ;
 * transforme l'erreur cryptique "table does not exist" en instruction claire.
 */
/**
 * Réglages SQLite appliqués une fois par processus (P0.1).
 *
 * WAL (Write-Ahead Logging) : sans lui, une écriture bloque TOUTES les
 * lectures — concrètement l'interface se fige pendant qu'une sync écrit. Avec
 * WAL, lectures et écriture avancent en parallèle. `busy_timeout` évite un
 * échec sec en cas de contention (on attend au lieu de crasher), et
 * `synchronous=NORMAL` est le compromis recommandé avec WAL.
 */
let pragmasApplied = false;

/**
 * PIÈGE : plusieurs PRAGMA d'affectation RENVOIENT une ligne (`journal_mode`
 * renvoie le mode retenu, `busy_timeout` la valeur appliquée). Prisma refuse
 * cela sur `$executeRawUnsafe` — « Execute returned results, which is not
 * allowed in SQLite ». On passe donc TOUT par `$queryRawUnsafe`, qui accepte
 * aussi bien zéro ligne qu'une ligne.
 *
 * Et chaque PRAGMA a son propre try : groupés, la première exception faisait
 * sauter les suivantes. C'est ce qui s'est réellement produit en production —
 * WAL était bien posé (premier de la liste), mais `busy_timeout` levait, donc
 * ni lui ni `synchronous` n'étaient appliqués, et la seule trace était un
 * avertissement au démarrage.
 */
async function applyPragma(sql: string): Promise<void> {
  try {
    await db.$queryRawUnsafe(sql);
  } catch (err) {
    logger.warn('SQLite : PRAGMA refusé', { sql, error: (err as Error).message });
  }
}

export async function applySqlitePragmas(): Promise<void> {
  if (pragmasApplied) return;
  pragmasApplied = true;
  await applyPragma('PRAGMA journal_mode = WAL');
  await applyPragma('PRAGMA busy_timeout = 5000');
  await applyPragma('PRAGMA synchronous = NORMAL');
  // On RELIT les valeurs plutôt que de supposer qu'elles ont pris : c'est le
  // seul moyen de voir dans les logs qu'un réglage a été silencieusement perdu.
  try {
    const [j] = await db.$queryRawUnsafe<{ journal_mode?: string }[]>('PRAGMA journal_mode');
    const [b] = await db.$queryRawUnsafe<{ timeout?: number }[]>('PRAGMA busy_timeout');
    const [s] = await db.$queryRawUnsafe<{ synchronous?: number }[]>('PRAGMA synchronous');
    logger.info('SQLite prêt', {
      journalMode: j?.journal_mode ?? 'inconnu',
      busyTimeout: b?.timeout ?? 'inconnu',
      synchronous: s?.synchronous ?? 'inconnu',
    });
  } catch {
    /* la relecture est un confort de diagnostic, jamais un motif d'échec */
  }
}

export async function ensureDbReady(): Promise<void> {
  try {
    await db.$queryRaw`SELECT 1 FROM Account LIMIT 1`;
    await applySqlitePragmas();
  } catch (err) {
    logger.warn('base non migrée', { error: (err as Error).message });
    throw new Error(
      "Base de données non initialisée. Lancer : npm run db:setup " +
        '(crée data/boxmail.db et applique les migrations).',
    );
  }
}
