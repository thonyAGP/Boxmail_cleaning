import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { checkUpdates } from './update.js';

const execFileP = promisify(execFile);

/**
 * Mise à jour automatique du serveur (déploiement sans intervention).
 *
 * POURQUOI : demander à l'utilisateur de se connecter en SSH à chaque
 * livraison n'est pas tenable. Le serveur va donc chercher lui-même les
 * nouveautés, une fois par nuit.
 *
 * SÉCURITÉ — le principe est « on ne redémarre QUE si tout s'est bien passé » :
 *  1. on note le commit actuel ;
 *  2. sauvegarde de la base ;
 *  3. pull → npm install → génération du client Prisma → build
 *     (jamais de migration ici : la base est tenue par l'app qui tourne) ;
 *  4. si UNE étape échoue : `git reset --hard` sur le commit d'avant,
 *     recompilation, et on continue de tourner sur l'ancienne version.
 *     Mieux vaut une version d'hier qui marche qu'une version du jour cassée.
 *  5. si tout va bien : on sort, le superviseur (pm2) relance sur le neuf.
 *
 * Sur Windows, rien de tout ça : le lanceur MailAssistant.bat met déjà à jour
 * à chaque démarrage, et les fichiers natifs sont verrouillés tant que le
 * serveur tourne.
 */

export interface AutoUpdateState {
  enabled: boolean;
  hour: number;
  lastRunAt: string | null;
  lastResult: 'à jour' | 'mis à jour' | 'échec' | null;
  lastMessage: string | null;
  nextRunAt: string | null;
}

const state: AutoUpdateState = {
  enabled: false,
  hour: -1,
  lastRunAt: null,
  lastResult: null,
  lastMessage: null,
  nextRunAt: null,
};

export function autoUpdateStatus(): AutoUpdateState {
  return { ...state };
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd: process.cwd() });
  return stdout.trim();
}

function run(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, cwd: process.cwd() });
    let tail = '';
    const onData = (buf: Buffer) => {
      tail = (tail + buf.toString('utf8')).slice(-2000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`« ${command} » a échoué (code ${code}) : ${tail.trim().slice(-400)}`));
    });
  });
}

/**
 * Un passage : vérifie, met à jour si besoin, revient en arrière en cas de
 * problème. Retourne ce qui s'est passé (aussi utilisé par les tests).
 */
export async function runAutoUpdate(): Promise<{
  result: 'à jour' | 'mis à jour' | 'échec';
  message: string;
  behind?: number;
}> {
  state.lastRunAt = new Date().toISOString();
  let previous = '';
  try {
    const { behind, commits } = await checkUpdates();
    if (behind === 0) {
      state.lastResult = 'à jour';
      state.lastMessage = 'aucune nouveauté';
      return { result: 'à jour', message: 'aucune nouveauté', behind: 0 };
    }
    logger.info('mise à jour automatique : nouveautés détectées', { behind });
    previous = await git('rev-parse', 'HEAD');

    // Filet : la base peut évoluer (migrations) — on sauvegarde d'abord.
    try {
      const { createBackup } = await import('./backup.js');
      await createBackup('avant-mise-a-jour-auto');
    } catch (err) {
      logger.warn('sauvegarde avant mise à jour auto impossible', {
        error: (err as Error).message,
      });
    }

    const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
    await run(`git pull --ff-only origin ${branch}`);
    await run('npm install --no-audit --no-fund');
    // Aucune migration ici : l'app tourne et tient la base (« database is
    // locked »). On régénère seulement le client Prisma ; les migrations sont
    // appliquées au redémarrage, base libre — voir src/db/migrate.ts.
    await run('npm run db:generate');
    await run('npm run build');

    state.lastResult = 'mis à jour';
    state.lastMessage = `${behind} nouveauté(s) : ${commits.slice(0, 3).join(' · ')}`;
    logger.info('mise à jour automatique appliquée, redémarrage', { behind });
    // pm2 relance le processus sur le nouveau code.
    setTimeout(() => process.exit(0), 2000);
    return { result: 'mis à jour', message: state.lastMessage, behind };
  } catch (err) {
    const message = (err as Error).message;
    state.lastResult = 'échec';
    state.lastMessage = message;
    logger.warn('mise à jour automatique en échec', { error: message });

    // Retour à la version qui fonctionnait : on préfère hier qui marche à
    // aujourd'hui qui plante. Le serveur continue de tourner pendant ce temps.
    if (previous) {
      try {
        await git('reset', '--hard', previous);
        await run('npm run build');
        state.lastMessage = `${message} — retour à la version précédente (${previous.slice(0, 7)}).`;
        logger.info('retour à la version précédente réussi', { commit: previous.slice(0, 7) });
      } catch (rollbackErr) {
        state.lastMessage =
          `${message} — ET le retour en arrière a échoué : ${(rollbackErr as Error).message}`;
        logger.error('retour en arrière impossible', { error: (rollbackErr as Error).message });
      }
    }
    return { result: 'échec', message: state.lastMessage ?? message };
  }
}

/** Millisecondes jusqu'au prochain passage à l'heure demandée. */
function msUntilHour(hour: number, now = new Date()): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function startAutoUpdate(): void {
  const hour = config.update.autoHour;
  state.hour = hour;
  if (hour < 0 || hour > 23) {
    logger.info('mise à jour automatique désactivée (AUTO_UPDATE_HOUR non défini)');
    return;
  }
  if (process.platform === 'win32') {
    // MailAssistant.bat met déjà à jour au démarrage.
    logger.info('mise à jour automatique ignorée sous Windows (le lanceur s’en charge)');
    return;
  }
  state.enabled = true;

  const schedule = () => {
    const delay = msUntilHour(hour);
    state.nextRunAt = new Date(Date.now() + delay).toISOString();
    const timer = setTimeout(() => {
      runAutoUpdate()
        .catch((err) => logger.warn('mise à jour auto : erreur inattendue', { error: err.message }))
        .finally(schedule);
    }, delay);
    timer.unref(); // ne retient pas le process à l'arrêt
  };
  schedule();
  logger.info('mise à jour automatique activée', { hour, nextRunAt: state.nextRunAt });
}
