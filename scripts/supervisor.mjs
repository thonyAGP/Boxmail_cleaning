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
//
// RETOUR EN ARRIÈRE (audit du 03/09, ticket D3) : jusqu'ici, un échec de npm
// install / prisma generate / tsc relançait la même commande toutes les 15 s,
// SANS LIMITE. Un commit cassé poussé le soir donnait donc, au double-clic du
// lendemain, une fenêtre noire qui boucle sans rien dire — devant un
// utilisateur non technique, à qui la ligne de commande est fermée. La
// mécanique de deploy/update.sh (côté Linux) est reprise ici :
//   1. on note le commit AVANT le pull ;
//   2. deux tentatives, pas plus — un échec passager (réseau coupé, antivirus
//      qui verrouille un fichier) se répare tout seul, un commit cassé non ;
//   3. si la nouveauté est en cause, retour sur le commit d'avant, on
//      recompile, et on démarre : mieux vaut la version d'hier qui marche ;
//   4. le résultat part dans logs/update-status.json, que ⚙️ Paramètres sait
//      déjà afficher (src/services/autoupdate.ts), ET dans un bloc en français
//      à l'écran. Le superviseur ne se tait jamais et ne boucle jamais à
//      l'identique : il démarre, ou il explique et s'arrête (MailAssistant.bat
//      garde alors la fenêtre ouverte sur le message).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE_FILE = 'node_modules/.mailassistant-state.json';
// Même fichier que deploy/update.sh côté serveur — c'est celui que
// src/services/autoupdate.ts lit pour alimenter ⚙️ Paramètres. logs/ est
// gitignoré : rien n'entre au dépôt.
const STATUS_FILE = 'logs/update-status.json';

/**
 * Lance une commande, la laisse écrire à l'écran EN DIRECT, et garde ses
 * dernières lignes sous la main. Les deux comptent : sans l'affichage vivant,
 * une installation de deux minutes ressemble à un plantage ; sans le tampon,
 * le message d'échec n'aurait rien d'utile à raconter. (Même technique que
 * src/services/autoupdate.ts.)
 */
async function run(command) {
  console.log(`\n[Mail Assistant] $ ${command}`);
  const t0 = Date.now();
  const child = spawn(command, {
    shell: true,
    stdio: ['inherit', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });
  let tail = '';
  const capter = (flux, sortie) => {
    flux.on('data', (buf) => {
      const texte = buf.toString('utf8');
      sortie.write(texte);
      tail = (tail + texte).slice(-4000);
    });
  };
  capter(child.stdout, process.stdout);
  capter(child.stderr, process.stderr);
  const code = await new Promise((resolve) => {
    child.on('error', (err) => {
      tail += `\n${err.message}`;
      resolve(-1);
    });
    child.on('close', resolve);
  });
  console.log(`[Mail Assistant] … ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { ok: code === 0, tail: tail.trim() };
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

/**
 * Oublie les empreintes : la passe suivante refait TOUT. Un état à moitié vrai
 * (dépendances pas réinstallées, client Prisma pas régénéré) peut être la
 * cause même de l'échec qu'on essaie de réparer.
 */
function oublierEtat() {
  try {
    rmSync(STATE_FILE, { force: true });
  } catch {
    // tant pis : au pire la passe suivante saute une étape déjà faite.
  }
}

/** Les 12 dernières lignes utiles — de quoi diagnostiquer sans noyer l'écran. */
function dernieresLignes(texte, n = 12) {
  return String(texte || '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(-n)
    .join(' | ');
}

/**
 * Écrit le résultat là où l'interface le lit. `result` ne peut valoir que
 * « à jour », « mis à jour » ou « échec » : src/services/autoupdate.ts n'en
 * connaît pas d'autres et rendrait n'importe quoi d'autre invisible.
 */
function ecrireStatut(result, message) {
  try {
    mkdirSync('logs', { recursive: true });
    writeFileSync(
      STATUS_FILE,
      `${JSON.stringify({
        ranAt: new Date().toISOString(),
        result,
        message,
        commit: gitOut(['rev-parse', '--short', 'HEAD']) || 'inconnu',
        // Marqueur : le superviseur n'efface que ses propres statuts, jamais
        // celui qu'un deploy/update.sh aurait laissé.
        source: 'supervisor',
      })}\n`,
    );
  } catch {
    // Le bloc affiché à l'écran reste le canal de secours.
  }
}

function effacerStatut() {
  try {
    const brut = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
    if (brut && brut.source === 'supervisor') rmSync(STATUS_FILE, { force: true });
  } catch {
    // Absent, illisible, ou écrit par deploy/update.sh : on n'y touche pas.
  }
}

/**
 * Les fichiers suivis modifiés localement — ce qu'un `git reset --hard`
 * détruirait. `package-lock.json` en est EXCLU volontairement : npm le
 * renormalise parfois tout seul au passage (constaté au banc), et une virgule
 * réécrite par npm ne doit pas désactiver en silence le retour en arrière.
 * Personne ne travaille à la main dans ce fichier sans toucher package.json.
 */
function modifsLocales() {
  return gitOut(['status', '--porcelain', '--untracked-files=no'])
    .split('\n')
    // « XY chemin ». gitOut() a déjà rogné les blancs de tête, donc la première
    // ligne peut n'avoir qu'une lettre d'état : compter les caractères serait
    // faux (ça mangeait le « t » de tsconfig.json — vu au banc).
    .map((l) => l.trim().replace(/^[A-Z?!]{1,2}\s+/, ''))
    .filter((f) => f !== '' && f !== 'package-lock.json');
}

/** Un encadré lisible — l'utilisateur ne lit pas les logs, il lit ce bloc. */
function bloc(lignes) {
  const barre = '='.repeat(70);
  console.log(`\n${barre}`);
  for (const ligne of lignes) console.log(ligne);
  console.log(`${barre}\n`);
}

/**
 * Les trois étapes de préparation, chacune conditionnelle. Rend `null` si tout
 * va bien, sinon { etape, detail } : la PREMIÈRE qui a échoué.
 */
async function preparer(dirty) {
  const state = loadState();

  // 1. Dépendances — seulement si package-lock a changé (ou node_modules absent).
  const lockHash = fileHash('package-lock.json');
  if (dirty || !existsSync('node_modules') || state.lockHash !== lockHash) {
    const r = await run('npm install --no-audit --no-fund');
    if (!r.ok) return { etape: 'installation des dépendances (npm install)', detail: r.tail };
    state.lockHash = lockHash;
    saveState(state);
  } else {
    console.log('[Mail Assistant] Dépendances inchangées — npm install sauté.');
  }

  // 2. Client Prisma — seulement si le schéma a changé (ou client absent).
  const schemaHash = fileHash('prisma/schema.prisma');
  if (dirty || state.schemaHash !== schemaHash || !existsSync('node_modules/.prisma/client')) {
    const r = await run('npm run db:generate');
    if (!r.ok) return { etape: 'préparation de la base (prisma generate)', detail: r.tail };
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
    const r = await run('npm run build');
    if (!r.ok) return { etape: 'compilation du serveur (npm run build)', detail: r.tail };
    state.srcTree = srcTree;
    saveState(state);
  } else {
    console.log('[Mail Assistant] Code serveur inchangé — compilation sautée.');
  }

  return null;
}

console.log('[Mail Assistant] Superviseur démarré (Ctrl+C pour tout arrêter).');

for (;;) {
  // Le commit d'AVANT le pull : c'est la version dont on sait qu'elle a
  // démarré au moins une fois. C'est là qu'on reviendra si la neuve casse.
  const avant = gitOut(['rev-parse', 'HEAD']);
  const pull = await run('git pull --ff-only');
  if (!pull.ok) {
    console.log(
      '[Mail Assistant] Mise à jour impossible (pas de connexion, ou modifications locales)' +
        ' — on continue sur la version déjà installée.',
    );
  }
  const apres = gitOut(['rev-parse', 'HEAD']);
  const nouveaute = avant !== '' && apres !== '' && avant !== apres;

  // Des modifications locales non commitées sur les entrées du build =
  // situation de développement : on ne fait confiance à aucune empreinte.
  const dirty =
    gitOut(['status', '--porcelain', '--', 'src', 'prisma', 'tsconfig.json', 'package-lock.json']) !== '';

  let echec = await preparer(dirty);
  const premierEchec = echec;
  let statutPose = false;

  // Seconde tentative — et la dernière. Un échec passager (réseau coupé
  // pendant npm install, fichier verrouillé une seconde par l'antivirus) se
  // répare de lui-même ; un commit cassé, jamais.
  if (echec) {
    console.log(
      `\n[Mail Assistant] Échec : ${echec.etape}.` +
        ' Seconde et dernière tentative dans 15 s (tout sera refait de zéro)…',
    );
    await sleep(15_000);
    oublierEtat();
    echec = await preparer(dirty);
  }

  // Deux échecs de suite juste après avoir récupéré des nouveautés : ce sont
  // elles qui sont en cause. Retour sur la version d'hier.
  if (echec && nouveaute) {
    const enCours = modifsLocales();
    if (enCours.length > 0) {
      // Poste de développement : on ne détruit pas le travail en cours. Les
      // fichiers sont NOMMÉS — sans eux, le filet paraîtrait simplement absent.
      bloc([
        '⚠️  Pas de retour en arrière automatique : du travail non enregistré existe ici.',
        '',
        `Fichiers modifiés localement : ${enCours.slice(0, 8).join(', ')}${enCours.length > 8 ? `, … (${enCours.length} au total)` : ''}`,
        "Enregistre-les (commit) ou annule-les, puis relance — le retour en arrière refonctionnera.",
      ]);
    } else {
      bloc([
        '⚠️  La mise à jour ne se compile pas. Retour à la version précédente…',
        '',
        `Étape en échec : ${premierEchec.etape}`,
        `Version visée   : ${avant.slice(0, 7)} (celle d'avant la mise à jour)`,
      ]);
      oublierEtat();
      const reset = await run(`git reset --hard ${avant}`);
      const echecRetour = reset.ok
        ? await preparer(false)
        : { etape: 'retour à la version précédente (git reset)', detail: reset.tail };
      if (!echecRetour) {
        ecrireStatut(
          'échec',
          `Mise à jour abandonnée, retour sur ${avant.slice(0, 7)} (la version d'avant, qui fonctionne).` +
            ` Étape en échec : ${premierEchec.etape}. Détail : ${dernieresLignes(echec.detail)}`,
        );
        statutPose = true;
        bloc([
          '⚠️  Mise à jour abandonnée — Mail Assistant est reparti sur la version précédente.',
          '',
          `Étape en échec  : ${premierEchec.etape}`,
          `Version relancée : ${avant.slice(0, 7)}`,
          '',
          "Tu peux te servir de l'application normalement : c'est celle d'hier.",
          'Le détail est aussi dans ⚙️ Paramètres, ligne « mise à jour ».',
          'La prochaine mise à jour réessaiera toute seule.',
        ]);
        echec = null;
      } else {
        echec = echecRetour;
      }
    }
  }

  if (echec) {
    const detail = dernieresLignes(echec.detail);
    ecrireStatut('échec', `Démarrage en échec : ${echec.etape}. Détail : ${detail}`);
    statutPose = true;
    if (existsSync('dist/index.js')) {
      bloc([
        "⚠️  Impossible de préparer la nouvelle version — démarrage sur la dernière version compilée.",
        '',
        `Étape en échec : ${echec.etape}`,
        `Détail : ${detail}`,
        '',
        "L'application va s'ouvrir, mais elle ne contient pas les dernières nouveautés.",
        'Signale ce message si tu attendais un changement.',
      ]);
    } else {
      bloc([
        "⛔  Mail Assistant n'a pas pu démarrer.",
        '',
        `Étape en échec : ${echec.etape}`,
        `Détail : ${detail}`,
        '',
        'Ce que tu peux faire :',
        '  1. vérifie ta connexion Internet, puis relance Mail Assistant (double-clic) ;',
        '  2. si le problème revient, recopie les lignes ci-dessus et envoie-les.',
        '',
        "Je m'arrête là plutôt que de réessayer sans fin : la fenêtre reste",
        'ouverte pour que tu puisses lire ce message.',
      ]);
      process.exit(1);
    }
  }

  // Passage entièrement sain : plus rien à signaler dans ⚙️ Paramètres.
  if (!statutPose) effacerStatut();

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
