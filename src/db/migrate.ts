import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from './client.js';
import { logger } from '../logger.js';

/**
 * Migrations appliquées AU DÉMARRAGE, pas pendant que le serveur tourne.
 *
 * POURQUOI (bug réel du 28/07, serveur Oracle) : la mise à jour lançait
 * `npm run db:setup` alors que l'application tournait et tenait le fichier
 * SQLite ouvert. Le moteur de migration Prisma veut un accès exclusif →
 * « Error: SQLite database error / database is locked », mise à jour en
 * échec. C'est le même piège que sous Windows (fichiers verrouillés), et il
 * se serait reproduit CHAQUE NUIT avec la mise à jour automatique.
 *
 * La règle est donc : on ne migre JAMAIS pendant que l'app sert.
 *  - pendant la mise à jour : `prisma generate` seulement (ne touche pas la base) ;
 *  - au démarrage suivant : les migrations en attente, avant toute requête,
 *    quand plus personne ne tient la base.
 *
 * Coût : nul en fonctionnement normal — on ne lance le moteur de migration
 * que s'il y a vraiment quelque chose à appliquer.
 */

const MIGRATIONS_DIR = resolve(process.cwd(), 'prisma', 'migrations');

/** Noms des dossiers de migration présents dans le dépôt, dans l'ordre. */
export function migrationsOnDisk(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Migrations présentes dans le dépôt mais pas encore appliquées à la base.
 * Base neuve (table `_prisma_migrations` absente) ⇒ toutes sont en attente.
 */
export async function pendingMigrations(): Promise<string[]> {
  const disk = migrationsOnDisk();
  if (disk.length === 0) return [];
  let applied: Set<string>;
  try {
    const rows = await db.$queryRawUnsafe<{ migration_name: string; finished_at: unknown }[]>(
      'SELECT migration_name, finished_at FROM _prisma_migrations',
    );
    // finished_at NULL = migration commencée puis interrompue : à rejouer.
    applied = new Set(rows.filter((r) => r.finished_at != null).map((r) => r.migration_name));
  } catch {
    return disk;
  }
  return disk.filter((name) => !applied.has(name));
}

function run(command: string): Promise<void> {
  return new Promise((resolve_, reject) => {
    const child = spawn(command, { shell: true, cwd: process.cwd() });
    let tail = '';
    const onData = (buf: Buffer) => {
      tail = (tail + buf.toString('utf8')).slice(-2000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve_();
      else reject(new Error(`« ${command} » a échoué (code ${code}) : ${tail.trim().slice(-400)}`));
    });
  });
}

/**
 * À appeler au démarrage, AVANT d'ouvrir le service. Ne fait rien si la base
 * est à jour. Sinon : ferme la connexion (libère le verrou SQLite) puis
 * applique les migrations en attente.
 */
export async function ensureMigrationsApplied(): Promise<{ applied: string[] }> {
  const pending = await pendingMigrations();
  if (pending.length === 0) return { applied: [] };
  logger.info('migrations en attente', { count: pending.length, premiere: pending[0] });
  // Libère le fichier SQLite : le moteur de migration exige l'exclusivité.
  await db.$disconnect();
  await run('npm run db:migrate');
  logger.info('migrations appliquées', { count: pending.length });
  return { applied: pending };
}
