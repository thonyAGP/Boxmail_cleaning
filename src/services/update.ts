import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const execFileP = promisify(execFile);

/**
 * Auto-mise à jour du serveur depuis le dépôt git.
 *
 * - version()      : commit/branche/date actuels (affichés dans l'interface)
 * - checkUpdates() : git fetch + nombre de commits de retard + leurs titres
 * - applyUpdate()  : pull --ff-only → npm install → db:setup → build → exit(0)
 *   Le superviseur (start-boxmail.bat, pm2, systemd) relance le processus,
 *   qui repart sur le nouveau code. Aucune entrée utilisateur n'est passée
 *   aux commandes (fixes), le tout derrière la session admin.
 */

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd: process.cwd() });
  return stdout.trim();
}

export interface VersionInfo {
  commit: string;
  date: string;
  branch: string;
}

let cachedVersion: VersionInfo | null = null;

export async function version(): Promise<VersionInfo> {
  if (cachedVersion) return cachedVersion;
  try {
    const [commit, date, branch] = await Promise.all([
      git('log', '-1', '--format=%h'),
      git('log', '-1', '--format=%cd', '--date=format:%d/%m/%Y %H:%M'),
      git('rev-parse', '--abbrev-ref', 'HEAD'),
    ]);
    cachedVersion = { commit, date, branch };
  } catch (err) {
    logger.warn('version git indisponible', { error: (err as Error).message });
    cachedVersion = { commit: 'inconnu', date: '', branch: '' };
  }
  return cachedVersion;
}

export async function checkUpdates(): Promise<{
  behind: number;
  commits: string[];
  branch: string;
}> {
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  await git('fetch', 'origin', branch);
  const behindStr = await git('rev-list', '--count', `HEAD..origin/${branch}`);
  const behind = Number.parseInt(behindStr, 10) || 0;
  const commits = behind
    ? (await git('log', `HEAD..origin/${branch}`, '--format=%s', '-10')).split('\n')
    : [];
  return { behind, commits, branch };
}

/** Lance une commande shell fixe en streamant sa sortie vers le job. */
function runStep(command: string, progress: (m: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    progress(`$ ${command}`);
    const child = spawn(command, { shell: true, cwd: process.cwd() });
    const onData = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed) progress(`  ${trimmed.slice(0, 200)}`);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`« ${command} » a échoué (code ${code}).`));
    });
  });
}

export async function applyUpdate(progress: (m: string) => void): Promise<{ restarted: boolean }> {
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  await runStep(`git pull --ff-only origin ${branch}`, progress);

  if (process.platform === 'win32') {
    // Windows verrouille les fichiers natifs (.dll/.node) chargés par le
    // processus : `prisma generate` échouerait (EPERM) tant que le serveur
    // tourne. On délègue install + db:setup + build à start-boxmail.bat,
    // qui les exécute après l'arrêt du serveur, juste avant de le relancer.
    progress('Code récupéré — installation et compilation au redémarrage (start-boxmail.bat)…');
  } else {
    await runStep('npm install --no-audit --no-fund', progress);
    await runStep('npm run db:setup', progress);
    await runStep('npm run build', progress);
  }

  cachedVersion = null;
  progress('✅ Mise à jour prête — redémarrage du serveur dans 2 secondes…');
  logger.info('mise à jour appliquée, redémarrage');
  // Le superviseur (bat/pm2/systemd) relance le processus sur le nouveau code.
  setTimeout(() => process.exit(0), 2000);
  return { restarted: true };
}
