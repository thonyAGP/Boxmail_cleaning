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
export async function ensureDbReady(): Promise<void> {
  try {
    await db.$queryRaw`SELECT 1 FROM Account LIMIT 1`;
  } catch (err) {
    logger.warn('base non migrée', { error: (err as Error).message });
    throw new Error(
      "Base de données non initialisée. Lancer : npm run db:setup " +
        '(crée data/boxmail.db et applique les migrations).',
    );
  }
}
