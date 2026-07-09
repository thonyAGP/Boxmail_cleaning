// Superviseur Mail Assistant : met à jour, compile, démarre le serveur et le
// relance quand il s'arrête (ex. mise à jour depuis l'interface).
//
// Pourquoi Node et pas un .bat ? Windows exécute les .bat en les lisant au fil
// de l'eau : si `git pull` modifie le fichier en cours d'exécution, le curseur
// de lecture atterrit n'importe où ("'e...' n'est pas reconnu…"). Ce script,
// lui, est chargé entièrement en mémoire au lancement — les mises à jour ne
// peuvent pas le casser pendant qu'il tourne (la nouvelle version prendra
// effet au prochain lancement).
import { spawn, spawnSync } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(command) {
  console.log(`\n[Mail Assistant] $ ${command}`);
  const r = spawnSync(command, { shell: true, stdio: 'inherit', cwd: process.cwd() });
  return r.status === 0;
}

console.log('[Mail Assistant] Superviseur démarré (Ctrl+C pour tout arrêter).');

for (;;) {
  run('git pull --ff-only');
  run('npm install --no-audit --no-fund');
  run('npm run db:setup');
  if (!run('npm run build')) {
    console.log('[Mail Assistant] Échec de compilation — nouvelle tentative dans 15 s…');
    await sleep(15_000);
    continue;
  }

  console.log('\n[Mail Assistant] Démarrage : http://localhost:8787/admin');
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
