import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';

/**
 * Sauvegarde de la base (P0.3).
 *
 * POURQUOI : l'index des mails est un cache reconstructible depuis IMAP, mais
 * le reste NE L'EST PAS — tâches, échéances validées, règles de classement,
 * catégories et priorités corrigées à la main, verdicts de qualité, briefs
 * archivés, suggestions ignorées. Perdre `data/boxmail.db`, c'est perdre tout
 * le travail d'organisation, même si les mails eux-mêmes restent chez
 * Microsoft.
 *
 * COMMENT : `VACUUM INTO` produit une copie COHÉRENTE de la base même pendant
 * une écriture (contrairement à une copie de fichier brute qui, en mode WAL,
 * peut capturer un état partiel). Le fichier obtenu est une base SQLite
 * normale : la restauration consiste à le remettre à la place de l'original.
 */

const BACKUP_DIR = resolve(process.cwd(), 'backups');
/** Nombre de sauvegardes conservées (rotation). */
const KEEP = 7;
/** Intervalle de la sauvegarde périodique. */
const DAILY_MS = 24 * 3600 * 1000;

export interface BackupInfo {
  file: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  // Les secondes évitent que deux sauvegardes rapprochées (deux clics, ou une
  // manuelle juste avant une mise à jour) portent le même nom et s'écrasent.
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}`
  );
}

/**
 * Crée une sauvegarde et applique la rotation. `reason` sert au nom du
 * fichier (auto / avant-mise-a-jour / manuelle) pour s'y retrouver.
 */
export async function createBackup(reason = 'auto'): Promise<BackupInfo> {
  await ensureDbReady();
  mkdirSync(BACKUP_DIR, { recursive: true });
  const safeReason = reason.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const file = `boxmail_${stamp(new Date())}_${safeReason}.db`;
  const path = join(BACKUP_DIR, file);
  if (existsSync(path)) unlinkSync(path); // VACUUM INTO refuse d'écraser

  // Le chemin est injecté dans du SQL : on n'accepte que le nôtre (pas
  // d'entrée utilisateur ici), et on échappe les quotes par précaution.
  await db.$executeRawUnsafe(`VACUUM INTO '${path.replace(/'/g, "''")}'`);

  const size = statSync(path).size;
  logger.info('sauvegarde créée', { file, sizeBytes: size, reason });
  rotate();
  return { file, path, sizeBytes: size, createdAt: new Date().toISOString() };
}

/** Ne conserve que les KEEP sauvegardes les plus récentes. */
function rotate(): void {
  try {
    const files = listBackups();
    for (const old of files.slice(KEEP)) {
      unlinkSync(old.path);
      logger.info('ancienne sauvegarde supprimée', { file: old.file });
    }
  } catch (err) {
    logger.warn('rotation des sauvegardes en échec', { error: (err as Error).message });
  }
}

/** Sauvegardes existantes, de la plus récente à la plus ancienne. */
export function listBackups(): BackupInfo[] {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('boxmail_') && f.endsWith('.db'))
    .map((f) => {
      const path = join(BACKUP_DIR, f);
      const st = statSync(path);
      return { file: f, path, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Chemin d'une sauvegarde par son nom de fichier (téléchargement) — null si inconnue. */
export function backupPath(file: string): string | null {
  // Anti-traversée : on ne sert que des fichiers réellement listés.
  return listBackups().find((b) => b.file === file)?.path ?? null;
}

/**
 * Sauvegarde périodique. Une sauvegarde est faite au démarrage si la dernière
 * date de plus de 24 h (le serveur peut être arrêté au moment prévu), puis
 * toutes les 24 h.
 */
export function startAutoBackup(): void {
  const run = (reason: string) => {
    createBackup(reason).catch((err) =>
      logger.warn('sauvegarde automatique en échec', { error: (err as Error).message }),
    );
  };

  const last = listBackups()[0];
  const lastAge = last ? Date.now() - Date.parse(last.createdAt) : Infinity;
  if (lastAge > DAILY_MS) run('auto');

  const timer = setInterval(() => run('auto'), DAILY_MS);
  timer.unref(); // ne retient pas le process à l'arrêt
  logger.info('sauvegarde automatique activée', { intervalHours: 24, keep: KEEP });
}
