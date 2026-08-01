// Superviseur Mail Assistant : met à jour, compile, démarre le serveur et le
// relance quand il s'arrête (ex. mise à jour depuis l'interface).
//
// Pourquoi Node et pas un .bat ? Windows exécute les .bat en les lisant au fil
// de l'eau : si `git pull` modifie le fichier en cours d'exécution, le curseur
// de lecture atterrit n'importe où ("'e...' n'est pas reconnu…"). Ce script,
// lui, est chargé entièrement en mémoire au lancement — les mises à jour ne
// peuvent pas le casser pendant qu'il tourne (la nouvelle version prendra
// effet au prochain lancement).
//
// ÉTAPES CONDITIONNELLES (retour utilisateur 01/08 : « chaque mise à jour
// prend 3 minutes ») : npm install, prisma generate et tsc ne tournent que si
// leurs ENTRÉES ont changé (package-lock, schema.prisma, arbre src/). Une mise
// à jour qui ne touche que l'interface (web/) redémarre en quelques secondes.
// Les migrations de base ne sont PAS lancées ici : le serveur les applique
// lui-même au démarrage (src/db/migrate.ts), uniquement s'il y en a en attente.
// L'état (empreintes des entrées) vit dans node_modules/ : supprimer
// node_modules efface l'état et force naturellement une passe complète.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE_FILE = 'node_modules/.mailassistant-state.json';

function run(command) {
  console.log(`\n[Mail Assistant] $ ${command}`);
  const t0 = Date.now();
  const r = spawnSync(command, { shell: true, stdio: 'inherit', cwd: process.cwd() });
  console.log(`[Mail Assistant] … ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return r.status === 0;
}

function gitOut(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', cwd: process.cwd() });
  return r.status === 0 ? r.stdout.trim() : '';
}

function fileHash(path) {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex');
  } catch {
    return 'absent';
  }
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    // node_modules absent : la passe complète en cours va le recréer.
  }
}

console.log('[Mail Assistant] Superviseur démarré (Ctrl+C pour tout arrêter).');

for (;;) {
  run('git pull --ff-only');

  const state = loadState();
  // Des modifications locales non commitées sur les entrées du build =
  // situation de développement : on ne fait confiance à aucune empreinte.
  const dirty =
    gitOut(['status', '--porcelain', '--', 'src', 'prisma', 'tsconfig.json', 'package-lock.json']) !== '';

  // 1. Dépendances — seulement si package-lock a changé (ou node_modules absent).
  const lockHash = fileHash('package-lock.json');
  if (dirty || !existsSync('node_modules') || state.lockHash !== lockHash) {
    if (!run('npm install --no-audit --no-fund')) {
      console.log('[Mail Assistant] Échec de npm install — nouvelle tentative dans 15 s…');
      await sleep(15_000);
      continue;
    }
    state.lockHash = lockHash;
    saveState(state);
  } else {
    console.log('[Mail Assistant] Dépendances inchangées — npm install sauté.');
  }

  // 2. Client Prisma — seulement si le schéma a changé (ou client absent).
  const schemaHash = fileHash('prisma/schema.prisma');
  if (dirty || state.schemaHash !== schemaHash || !existsSync('node_modules/.prisma/client')) {
    if (!run('npm run db:generate')) {
      console.log('[Mail Assistant] Échec de prisma generate — nouvelle tentative dans 15 s…');
      await sleep(15_000);
      continue;
    }
    state.schemaHash = schemaHash;
    saveState(state);
  } else {
    console.log('[Mail Assistant] Schéma de base inchangé — prisma generate sauté.');
  }
  // Pas de `prisma migrate` ici : le serveur applique lui-même les migrations
  // en attente à son démarrage (src/db/migrate.ts), base fermée, sans risque
  // de « database is locked ».

  // 3. Compilation — seulement si src/ ou tsconfig ont changé depuis le
  // dernier build réussi. `git rev-parse HEAD:src` = empreinte de TOUT src/.
  const srcTree = `${gitOut(['rev-parse', 'HEAD:src'])}|${fileHash('tsconfig.json')}`;
  if (dirty || !existsSync('dist/index.js') || state.srcTree !== srcTree) {
    if (!run('npm run build')) {
      console.log('[Mail Assistant] Échec de compilation — nouvelle tentative dans 15 s…');
      // On repart de zéro au prochain tour : un état à moitié vrai (deps pas
      // réinstallées, client pas régénéré) peut être la cause de l'échec.
      try { rmSync(STATE_FILE, { force: true }); } catch { /* tant pis */ }
      await sleep(15_000);
      continue;
    }
    state.srcTree = srcTree;
    saveState(state);
  } else {
    console.log('[Mail Assistant] Code serveur inchangé — compilation sautée.');
  }

  console.log(`\n[Mail Assistant] Démarrage : http://localhost:${process.env.PORT || 8787}/admin`);
  console.log('[Mail Assistant] (Laisser cette fenêtre ouverte.)\n');
  const child = spawn('node', ['dist/index.js'], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, BOXMAIL_SUPERVISED: '1' },
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  console.log(`\n[Mail Assistant] Serveur arrêté (code ${code}) — redémarrage dans 3 s…`);
  await sleep(3000);
}
