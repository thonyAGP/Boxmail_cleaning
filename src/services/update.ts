import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const execFileP = promisify(execFile);

/**
 * Auto-mise à jour du serveur depuis le dépôt git.
 *
 * - version()      : commit/branche/date actuels (affichés dans l'interface)
 * - checkUpdates() : git fetch + nombre de commits de retard + leurs titres
 * - applyUpdate()  : pull --ff-only → npm install → db:generate → build → exit(0)
 *   (les migrations de base attendent le redémarrage : voir src/db/migrate.ts)
 *   Le superviseur (MailAssistant.bat, pm2, systemd) relance le processus,
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
  /** true si un superviseur (MailAssistant.bat, pm2, systemd) relance le
   *  processus après un arrêt — condition du redémarrage automatique. */
  supervised: boolean;
}

let cachedVersion: VersionInfo | null = null;

export async function version(): Promise<VersionInfo> {
  if (cachedVersion) return cachedVersion;
  const supervised = process.env.BOXMAIL_SUPERVISED === '1';
  try {
    const [commit, date, branch] = await Promise.all([
      git('log', '-1', '--format=%h'),
      git('log', '-1', '--format=%cd', '--date=format:%d/%m/%Y %H:%M'),
      git('rev-parse', '--abbrev-ref', 'HEAD'),
    ]);
    cachedVersion = { commit, date, branch, supervised };
  } catch (err) {
    logger.warn('version git indisponible', { error: (err as Error).message });
    cachedVersion = { commit: 'inconnu', date: '', branch: '', supervised };
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
  // Chemin PRÉFÉRÉ sous Linux : déléguer au script système, hors application.
  // Un updater qui vit dans le binaire qu'il remplace ne peut pas se réparer
  // lui-même — c'est ce qui a imposé deux interventions SSH en trois mises à
  // jour (29/07). Le script, lui, récupère sa propre dernière version avant de
  // s'exécuter et revient en arrière tout seul en cas d'échec.
  const bootScript = resolve(process.cwd(), 'deploy', 'update-boot.sh');
  if (process.platform !== 'win32' && existsSync(bootScript)) {
    progress('Mise à jour confiée au script système (hors application)…');
    progress('Le serveur va redémarrer seul ; recharge la page dans une minute.');
    // Détaché : le script survit au redémarrage de pm2 qu'il déclenchera.
    const child = spawn('bash', [bootScript], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    cachedVersion = null;
    logger.info('mise à jour déléguée au script système');
    return { restarted: true };
  }

  return applyUpdateInProcess(progress);
}

/**
 * Ancien chemin : la mise à jour faite PAR l'application. Conservé pour
 * Windows (MailAssistant.bat prend le relais après l'arrêt) et comme repli si
 * le script système n'est pas encore déployé.
 */
async function applyUpdateInProcess(
  progress: (m: string) => void,
): Promise<{ restarted: boolean }> {
  // Filet de sécurité (P0.3) : une mise à jour peut faire évoluer la base
  // (migrations). On sauvegarde AVANT, jamais après — non bloquant : une
  // sauvegarde impossible ne doit pas empêcher la mise à jour.
  try {
    const { createBackup } = await import('./backup.js');
    const b = await createBackup('avant-mise-a-jour');
    progress(`💾 Sauvegarde faite (${b.file})`);
  } catch (err) {
    progress(`⚠️ Sauvegarde impossible (${(err as Error).message}) — on continue.`);
  }

  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  const previous = await git('rev-parse', 'HEAD');
  await runStep(`git pull --ff-only origin ${branch}`, progress);
  // Le dépôt vient de bouger : la version en cache est périmée DÈS
  // MAINTENANT, avant même de savoir si la suite réussit. Sans cette ligne,
  // un échec plus bas laissait l'interface afficher l'ancien commit tout en
  // annonçant « ✅ à jour » (le dépôt, lui, était en avance) — constaté en
  // réel le 29/07, et c'est ce qui rendait la panne illisible.
  cachedVersion = null;

  try {
    if (process.platform === 'win32') {
      // Windows verrouille les fichiers natifs (.dll/.node) chargés par le
      // processus : `prisma generate` échouerait (EPERM) tant que le serveur
      // tourne. On délègue install + db:setup + build à MailAssistant.bat,
      // qui les exécute après l'arrêt du serveur, juste avant de le relancer.
      progress(
        'Code récupéré — le superviseur ne refera au redémarrage que le nécessaire ' +
          '(dépendances/compilation seulement si elles ont changé)…',
      );
    } else {
      // `--include=dev` OBLIGATOIRE : pm2 lance l'app avec NODE_ENV=production,
      // npm écarte alors les devDependencies (typescript, @types/node) et le
      // build meurt sur « TS2688 ». Voir le commentaire jumeau dans
      // autoupdate.ts — c'est la panne du 29/07.
      await runStep('npm install --include=dev --no-audit --no-fund', progress);
      // PAS de migration ici : le serveur tourne et tient le fichier SQLite —
      // `prisma migrate deploy` échouerait sur « database is locked » (constaté
      // en réel sur le serveur le 28/07). On ne fait que régénérer le client
      // (aucun accès à la base) ; les migrations passent au redémarrage, via
      // ensureMigrationsApplied() — voir src/db/migrate.ts.
      await runStep('npm run db:generate', progress);
      await runStep('npm run build', progress);
    }
  } catch (err) {
    // Même principe que la mise à jour automatique : mieux vaut la version
    // d'hier qui marche. Sans ce retour, le dépôt restait EN AVANCE sur le
    // binaire réellement en service — état trompeur et difficile à diagnostiquer.
    progress(`⚠️ ${(err as Error).message}`);
    progress('↩️ Retour à la version précédente…');
    try {
      await git('reset', '--hard', previous);
      if (process.platform !== 'win32') await runStep('npm run build', progress);
      progress(`↩️ Revenu sur ${previous.slice(0, 7)} — le serveur continue de tourner.`);
    } catch (rollbackErr) {
      progress(`⛔ Retour en arrière impossible : ${(rollbackErr as Error).message}`);
    }
    cachedVersion = null;
    throw err;
  }

  cachedVersion = null;
  progress('✅ Mise à jour prête — redémarrage du serveur dans 2 secondes…');
  logger.info('mise à jour appliquée, redémarrage');
  // Le superviseur (bat/pm2/systemd) relance le processus sur le nouveau code.
  setTimeout(() => process.exit(0), 2000);
  return { restarted: true };
}
