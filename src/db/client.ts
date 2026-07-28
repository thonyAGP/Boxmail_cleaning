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

export async function applySqlitePragmas(): Promise<void> {
  if (pragmasApplied) return;
  pragmasApplied = true;
  try {
    const rows = await db.$queryRawUnsafe<{ journal_mode?: string }[]>(
      'PRAGMA journal_mode = WAL',
    );
    await db.$executeRawUnsafe('PRAGMA busy_timeout = 5000');
    await db.$executeRawUnsafe('PRAGMA synchronous = NORMAL');
    logger.info('SQLite prêt', { journalMode: rows?.[0]?.journal_mode ?? 'inconnu' });
  } catch (err) {
    // Non bloquant : la base fonctionne sans (mode journal par défaut).
    logger.warn('SQLite : PRAGMA non appliqués', { error: (err as Error).message });
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
