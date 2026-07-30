import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

/**
 * Audit de qualité — `npm run audit`
 *
 * POURQUOI CE SCRIPT EXISTE. Le 29/07, en corrigeant UN écran, trois défauts
 * distincts sont apparus : une colonne « Date » coupée par le débordement d'une
 * table (la donnée était pourtant renvoyée), des sujets non cliquables (donc
 * impossible de relire un mail avant de le supprimer), et une colonne non
 * indexée qui faisait tenir la page 40 secondes. Chacun a demandé une capture
 * d'écran de l'utilisateur. Ce mode de découverte ne tient pas.
 *
 * CE QUE CE SCRIPT N'EST PAS. Les règles statiques (familles A, B, C, F) sont
 * des expressions régulières sur 7 000 lignes de JavaScript : elles produisent
 * des PISTES, marquées « à vérifier », jamais des verdicts. Les traiter comme
 * une vérité mènerait à « corriger » des choix délibérés.
 *
 * CE QUI A DE LA VALEUR, c'est la partie dynamique (D, E, G) : on exécute les
 * vrais services sur la vraie base, on capture le SQL réellement émis et on le
 * passe à EXPLAIN QUERY PLAN. C'est ainsi que le défaut du 29/07 a été trouvé —
 * et surtout, c'est ainsi qu'on évite de perdre du temps sur le mauvais
 * suspect : j'avais d'abord optimisé les clauses de protection, qui ne
 * coûtaient que 179 ms sur 40 secondes.
 *
 *   npm run audit                 # tout
 *   npm run audit -- --static     # sans la base (aucune donnée requise)
 *   npm run audit -- --dry-run    # n'écrit pas les fichiers
 */

const ROOT = resolve(process.cwd());

/**
 * Dossier de sortie. `docs/` en local (les fichiers sont versionnés, l'écart
 * d'un passage à l'autre se lit dans le diff Git).
 *
 * Sur le SERVEUR il faut passer `--out logs` : `logs/` est ignoré par Git,
 * alors qu'écrire dans `docs/` salirait l'arbre de travail et ferait échouer le
 * `git merge --ff-only` de la mise à jour automatique — l'app se retrouverait
 * bloquée sur une vieille version à cause de son propre outil d'audit.
 */
let OUT_DIR = 'docs';
const store = (): string => join(ROOT, OUT_DIR, 'audit-findings.json');
const report = (): string => join(ROOT, OUT_DIR, 'AUDIT.md');
const chronosFile = (): string => join(ROOT, OUT_DIR, 'audit-chronos.md');

// --------------------------------------------------------------- le modèle

export type Family = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export type Severity = 'critique' | 'grave' | 'moyen' | 'faible';
export type Status = 'todo' | 'fixed' | 'accepted';

export interface Finding {
  /**
   * Clé STABLE : famille:fichier:fonction:règle. Volontairement SANS numéro de
   * ligne — une ligne bouge au moindre ajout, et la clé doit survivre pour que
   * le statut posé à la main (« corrigé », « accepté ») ne se perde pas.
   */
  key: string;
  family: Family;
  severity: Severity;
  file: string;
  fn: string;
  /** Informatif seulement : rafraîchi à chaque passage, jamais dans la clé. */
  line?: number;
  title: string;
  detail: string;
  detectedBy: 'exploration' | 'script';
  /** « à vérifier » = piste issue d'une regex ; « confirmé » = mesuré ou lu. */
  confidence: 'confirmé' | 'à vérifier';
  status: Status;
  note?: string;
  firstSeen: string;
  lastSeen: string;
  /** Chiffre associé (ms, nombre de lignes…), pour suivre l'évolution. */
  metric?: string;
}

const FAMILIES: Record<Family, string> = {
  A: 'Texte tronqué sans moyen de lire l’intégralité',
  B: 'Liste de mails non ouvrable',
  C: 'Liste de mails sans date de réception',
  D: 'Requête sans index / motif coûteux',
  E: 'Compteurs et totaux incohérents',
  F: 'Action sans confirmation ni retour visible',
  G: 'Écran lent',
};

const SEVERITY_ORDER: Severity[] = ['critique', 'grave', 'moyen', 'faible'];

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function mk(f: Omit<Finding, 'firstSeen' | 'lastSeen' | 'status'> & { status?: Status }): Finding {
  const t = now();
  return { status: 'todo', firstSeen: t, lastSeen: t, ...f };
}

// ------------------------------------------------------- règles STATIQUES

/** Numéro de ligne (1-indexé) d'un index de caractère dans un texte. */
function lineOf(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length;
}

/** Nom de la fonction englobante — heuristique : dernière déclaration au-dessus. */
function fnOf(text: string, idx: number): string {
  const before = text.slice(0, idx);
  const m = [...before.matchAll(/(?:^|\n)(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)];
  return m.length ? m[m.length - 1][1] : '(hors fonction)';
}

function auditFront(): Finding[] {
  const out: Finding[] = [];
  const appPath = join(ROOT, 'web', 'js', 'app.js');
  const cssPath = join(ROOT, 'web', 'styles.css');
  if (!existsSync(appPath)) return out;
  const app = readFileSync(appPath, 'utf8');
  const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';

  // --- A : troncature sans infobulle ---------------------------------------
  // On regarde la « ligne logique » : une balise HTML tient rarement sur
  // plusieurs lignes dans ce fichier, et un title= voisin suffit à disculper.
  const lines = app.split('\n');
  lines.forEach((raw, i) => {
    // `nowrap` SEUL ne tronque pas : il empêche le retour à la ligne. Couper du
    // texte demande `text-overflow: ellipsis`, ou `nowrap` AVEC
    // `overflow: hidden`. La première version signalait chaque date en nowrap —
    // dont une que je venais d'ajouter, ce qui a mis le doigt sur l'erreur.
    const tronque =
      /text-overflow\s*:\s*ellipsis/.test(raw) ||
      (/white-space\s*:\s*nowrap/.test(raw) && /overflow\s*:\s*hidden/.test(raw));
    if (!tronque) return;
    // Fenêtre de 2 lignes : le title= est parfois sur l'attribut précédent.
    const fenetre = [lines[i - 1] ?? '', raw, lines[i + 1] ?? ''].join(' ');
    if (/title\s*=/.test(fenetre)) return;
    const idx = lines.slice(0, i).join('\n').length;
    const fn = fnOf(app, idx);
    out.push(
      mk({
        key: `A:web/js/app.js:${fn}:ellipsis-sans-title`,
        family: 'A',
        severity: 'moyen',
        file: 'web/js/app.js',
        fn,
        line: i + 1,
        title: 'Texte coupé sans infobulle',
        detail:
          'Cellule tronquée (ellipsis/nowrap) sans attribut title à proximité : ' +
          'le texte complet est irrécupérable pour l’utilisateur.',
        detectedBy: 'script',
        confidence: 'à vérifier',
      }),
    );
  });

  // --- A : .slice() d'affichage sans « … » ni title -------------------------
  for (const m of app.matchAll(/\.slice\(\s*0\s*,\s*(\d+)\s*\)/g)) {
    const idx = m.index ?? 0;
    const fen = app.slice(idx, idx + 320);
    if (/title\s*=|…|\.\.\.|autre\(s\)|＋/.test(fen)) continue;
    const fn = fnOf(app, idx);
    out.push(
      mk({
        key: `A:web/js/app.js:${fn}:slice-sans-indicateur`,
        family: 'A',
        severity: 'faible',
        file: 'web/js/app.js',
        fn,
        line: lineOf(app, idx),
        title: `Liste coupée à ${m[1]} sans indiquer le reste`,
        detail:
          'Un .slice() tronque l’affichage sans « … », sans « et N autre(s) » et ' +
          'sans title : rien ne signale à l’utilisateur qu’il manque des éléments.',
        detectedBy: 'script',
        confidence: 'à vérifier',
      }),
    );
  }

  // --- D : table dont la DERNIÈRE colonne est une date ----------------------
  // C'est le mécanisme exact du bug du 29/07 : une colonne en bout de ligne
  // sort du cadre dès qu'une cellule voisine s'élargit.
  for (const m of app.matchAll(/<thead>[\s\S]{0,600}?<\/tr>/g)) {
    const bloc = m[0];
    const ths = [...bloc.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => x[1].trim());
    if (ths.length < 3) continue;
    const dernier = ths[ths.length - 1];
    if (!/date|reçu|recu/i.test(dernier)) continue;
    const idx = m.index ?? 0;
    const fn = fnOf(app, idx);
    out.push(
      mk({
        key: `D:web/js/app.js:${fn}:date-en-derniere-colonne`,
        family: 'D',
        severity: 'grave',
        file: 'web/js/app.js',
        fn,
        line: lineOf(app, idx),
        title: 'Colonne de date en bout de ligne',
        detail:
          'La date est la dernière colonne : c’est la position d’où elle sortait ' +
          'du cadre le 29/07 dès qu’une cellule voisine s’élargissait. ' +
          'La remonter et fixer les largeurs des <th>.',
        detectedBy: 'script',
        confidence: 'à vérifier',
      }),
    );
  }

  // --- B/D : modale listant des mails sans « under-reader » -----------------
  // Sans cette classe, le panneau de lecture s'ouvre DERRIÈRE l'overlay : le
  // sujet a beau être cliquable, on ne voit rien.
  for (const m of app.matchAll(/className\s*=\s*'modal-overlay'/g)) {
    const idx = m.index ?? 0;
    const fn = fnOf(app, idx);
    const corps = app.slice(idx, idx + 4000);
    if (!/openable|data-open|subject/i.test(corps)) continue;
    out.push(
      mk({
        key: `B:web/js/app.js:${fn}:overlay-sans-under-reader`,
        family: 'B',
        severity: 'grave',
        file: 'web/js/app.js',
        fn,
        line: lineOf(app, idx),
        title: 'Modale listant des mails sans « under-reader »',
        detail:
          'L’overlay n’a pas la classe under-reader : le panneau de lecture ' +
          's’ouvrirait DERRIÈRE la modale. Rendre un sujet cliquable ne suffit ' +
          'donc pas — il faut aussi changer la classe de l’overlay.',
        detectedBy: 'script',
        confidence: 'à vérifier',
      }),
    );
  }

  // --- D : classe CSS utilisée en JS mais absente de la feuille de style ----
  // C'est ainsi qu'on a trouvé `.tablewrap` : un conteneur censé apporter
  // overflow:auto et qui n'existait pas, donc une table qui déborde sans
  // barre de défilement.
  const definies = new Set<string>();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) definies.add(m[1]);
  const vues = new Map<string, number>();
  for (const m of app.matchAll(/class="([^"]{1,300})"/g)) {
    // PIÈGE : la valeur de l'attribut est souvent un gabarit
    // (`class="row ${x ? 'a' : 'b'}"`). Sans retirer les `${…}`, on prend
    // `'a'`, `?` et `:` pour des noms de classe — la première version de cette
    // règle sortait 103 faux positifs à cause de ça. On enlève les parties
    // dynamiques, puis on ne garde que des identifiants CSS valides.
    const statique = m[1].replace(/\$\{[^}]*\}/g, ' ');
    for (const c of statique.split(/\s+/)) {
      if (!/^[a-zA-Z][\w-]*$/.test(c)) continue;
      if (!vues.has(c)) vues.set(c, lineOf(app, m.index ?? 0));
    }
  }
  // Beaucoup de classes n'ont VOLONTAIREMENT aucun style : ce sont des
  // crochets que JavaScript interroge (`querySelectorAll('.ret-apply')`).
  // Sans cette exclusion la règle sortait 44 faux positifs. Ne reste signalé
  // que le cas réellement suspect : une classe ni stylée, ni jamais
  // interrogée — donc qui ne fait rien du tout (c'est le cas de `.tablewrap`,
  // conteneur censé apporter un overflow:auto et qui n'existe pas).
  const interrogees = new Set<string>();
  for (const m of app.matchAll(/['"`]\.([a-zA-Z][\w-]*)/g)) interrogees.add(m[1]);

  for (const [c, ligne] of vues) {
    if (definies.has(c) || interrogees.has(c)) continue;
    out.push(
      mk({
        key: `D:web/js/app.js:${c}:classe-css-inexistante`,
        family: 'D',
        severity: 'moyen',
        file: 'web/js/app.js',
        fn: `class="${c}"`,
        line: ligne,
        title: `Classe CSS « ${c} » utilisée mais jamais définie`,
        detail:
          'Le style attendu n’est jamais appliqué. Sur un conteneur de table, ' +
          'cela signifie un overflow:auto absent, donc une table qui déborde ' +
          'sans barre de défilement (cas réel : .tablewrap).',
        detectedBy: 'script',
        confidence: 'à vérifier',
      }),
    );
  }

  return out;
}

/** Octets nuls : ripgrep classe le fichier « binaire » et le SAUTE en silence. */
function auditOctetsNuls(): Finding[] {
  const out: Finding[] = [];
  const exts = ['.ts', '.js', '.mjs', '.css', '.html', '.json', '.md'];
  const ignore = /node_modules|[\\/]dist[\\/]|[\\/]\.git[\\/]|[\\/]data[\\/]/;
  const parcourir = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (ignore.test(p)) continue;
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        parcourir(p);
        continue;
      }
      if (!exts.some((x) => p.endsWith(x))) continue;
      const buf = readFileSync(p);
      const i = buf.indexOf(0);
      if (i < 0) continue;
      const rel = relative(ROOT, p).replace(/\\/g, '/');
      out.push(
        mk({
          key: `D:${rel}::octet-nul`,
          family: 'D',
          severity: 'grave',
          file: rel,
          fn: '(fichier entier)',
          title: 'Octet nul dans un fichier source',
          detail:
            `Octet nul à l’offset ${i}. Ripgrep classe le fichier comme binaire et ` +
            'le saute SANS RIEN DIRE : toute recherche, tout outil de la chaîne ' +
            'appuyé sur grep ignore ce fichier en silence.',
          detectedBy: 'script',
          confidence: 'confirmé',
          metric: `offset ${i}`,
        }),
      );
    }
  };
  for (const d of ['src', 'web', 'scripts', 'prisma', 'docs']) {
    const p = join(ROOT, d);
    if (existsSync(p)) parcourir(p);
  }
  return out;
}

// ------------------------------------------------------ règles DYNAMIQUES

interface Sonde {
  nom: string;
  ecran: string;
  run: () => Promise<unknown>;
}

/** Mots qui suivent une table sans en être l'alias. */
const PAS_UN_ALIAS = new Set([
  'ON', 'WHERE', 'GROUP', 'ORDER', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'JOIN',
  'LIMIT', 'HAVING', 'UNION', 'AS', 'SET', 'VALUES', 'USING', 'CROSS', 'NATURAL',
]);

/**
 * Alias → table réelle, lu dans le SQL.
 *
 * Indispensable : `EXPLAIN QUERY PLAN` répond « SCAN f », pas « SCAN Folder ».
 * Sans cette table de correspondance, impossible de savoir si le balayage porte
 * sur 73 lignes (Folder) ou 34 877 (Message).
 */
function aliasMap(sql: string): Map<string, string> {
  const m = new Map<string, string>();
  const re = /(?:FROM|JOIN)\s+(?:"?main"?\.)?"?([A-Za-z_]\w*)"?(?:\s+(?:AS\s+)?"?([A-Za-z_]\w*)"?)?/gi;
  for (const x of sql.matchAll(re)) {
    const table = x[1];
    const al = x[2];
    if (al && !PAS_UN_ALIAS.has(al.toUpperCase())) m.set(al, table);
    m.set(table, table);
  }
  return m;
}

async function auditDynamique(): Promise<Finding[]> {
  const out: Finding[] = [];
  process.env.BOXMAIL_SQL_TRACE = '1';

  const { db } = await import('../db/client.js');
  const capture: { sql: string; params: string }[] = [];
  // Prisma n'émet cet événement que si le client a été construit avec
  // log:[{emit:'event'}] — c'est le rôle de BOXMAIL_SQL_TRACE, posé ci-dessus
  // AVANT l'import (l'import dynamique garantit l'ordre).
  (db as unknown as { $on: (e: string, cb: (x: { query: string; params: string }) => void) => void }).$on(
    'query',
    (e) => capture.push({ sql: e.query, params: e.params }),
  );

  // Volumétrie : un balayage n'est un problème que sur une table peuplée.
  const tailles = new Map<string, number>();
  const tables = await db.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'`,
  );
  for (const t of tables) {
    const r = await db.$queryRawUnsafe<{ c: bigint }[]>(`SELECT COUNT(*) AS c FROM "${t.name}"`);
    tailles.set(t.name, Number(r[0]?.c ?? 0));
  }

  const { listAccountNames } = await import('../services/accounts.js');
  let comptes: string[] = [];
  try {
    comptes = await listAccountNames();
  } catch {
    /* base sans compte : les sondes globales restent utiles */
  }
  const un = comptes[0];

  // Imports un par un, volontairement : un Promise.all avec un tuple de
  // `typeof import(...)` faisait exploser le temps d'inférence de tsc
  // (typecheck > 3 minutes). Ici chaque module garde son type naturel.
  const today = await import('../services/today.js');
  const ret = await import('../services/retention.js');
  const report = await import('../services/report.js');
  const search = await import('../services/search.js');
  const stats = await import('../services/index-stats.js');
  const learn = await import('../services/learning.js');
  const unsub = await import('../services/unsubscribe.js');
  const ana = await import('../services/analysis.js');
  const snip = await import('../services/snippets.js');
  const tasks = await import('../services/tasks.js');
  const qual = await import('../services/quality.js');
  const clean = await import('../services/cleanup.js');
  const att = await import('../services/attention.js');
  const imp = await import('../services/importance.js');
  const brief = await import('../services/brief.js');

  const sondes: Sonde[] = [
    { nom: 'generateToday', ecran: '#/today (accueil)', run: () => today.generateToday() },
    { nom: 'listPolicies', ecran: '#/cleanup', run: () => ret.listPolicies() },
    { nom: 'deletableUnion', ecran: '#/cleanup + #/bigclean', run: () => ret.deletableUnion() },
    { nom: 'generateMailboxReport', ecran: '#/bigclean', run: () => report.generateMailboxReport() },
    { nom: 'globalOverview', ecran: '#/dashboard', run: () => stats.globalOverview() },
    { nom: 'listUnifiedInbox', ecran: '#/inbox', run: () => search.listUnifiedInbox({ limit: 50 }) },
    { nom: 'searchIndex', ecran: '#/search', run: () => search.searchIndex({ q: 'facture', limit: 50 }) },
    { nom: 'listSuggestions', ecran: '#/suggestions', run: () => learn.listSuggestions() },
    { nom: 'listUnsubscribable', ecran: '#/unsubscribe', run: () => unsub.listUnsubscribable() },
    { nom: 'analysisProgress', ecran: '⚙️ Paramètres', run: () => ana.analysisProgress() },
    { nom: 'analysisCoverage', ecran: '⚙️ Paramètres', run: () => snip.analysisCoverage() },
    { nom: 'listTasks', ecran: '#/tasks', run: () => tasks.listTasks() },
    { nom: 'getReviewSample', ecran: '#/verify', run: () => qual.getReviewSample(5) },
    { nom: 'generateBrief', ecran: '#/dashboard (brief)', run: () => brief.generateBrief({}) },
  ];
  if (un) {
    sondes.push(
      { nom: 'getCleanupCandidates', ecran: '#/cleanup', run: () => clean.getCleanupCandidates(un) },
      { nom: 'getUnansweredEmails', ecran: '#/replies', run: () => att.getUnansweredEmails(un, {}) },
      { nom: 'getImportantEmails', ecran: '#/important', run: () => imp.getImportantEmails(un, {}) },
    );
  }

  const chronos: { nom: string; ms: number; ecran: string }[] = [];

  for (const s of sondes) {
    capture.length = 0;
    const t0 = Date.now();
    try {
      await s.run();
    } catch (err) {
      out.push(
        mk({
          key: `G:service:${s.nom}:sonde-en-echec`,
          family: 'G',
          severity: 'faible',
          file: 'src/services',
          fn: s.nom,
          title: 'Sonde d’audit en échec',
          detail: `La sonde n’a pas pu s’exécuter : ${(err as Error).message}`,
          detectedBy: 'script',
          confidence: 'confirmé',
        }),
      );
      continue;
    }
    const ms = Date.now() - t0;
    chronos.push({ nom: s.nom, ms, ecran: s.ecran });

    // G — écran lent
    if (ms >= 1000) {
      out.push(
        mk({
          key: `G:service:${s.nom}:lent`,
          family: 'G',
          severity: ms >= 5000 ? 'critique' : ms >= 2000 ? 'grave' : 'moyen',
          file: 'src/services',
          fn: s.nom,
          title: `${s.ecran} : ${(ms / 1000).toFixed(1)} s`,
          detail:
            `${capture.length} requête(s) SQL. Au-delà d’une seconde l’utilisateur ` +
            'voit tourner la page — c’est le symptôme exact signalé le 29/07.',
          detectedBy: 'script',
          confidence: 'confirmé',
          metric: `${ms} ms`,
        }),
      );
    }

    // D — balayage de table peuplée, vu par le planificateur lui-même
    const dejaVu = new Set<string>();
    for (const q of capture) {
      if (!/^\s*SELECT/i.test(q.sql)) continue;
      let params: unknown[] = [];
      try {
        params = JSON.parse(q.params) as unknown[];
      } catch {
        params = [];
      }
      let plan: { detail: string }[];
      try {
        plan = await db.$queryRawUnsafe<{ detail: string }[]>(
          `EXPLAIN QUERY PLAN ${q.sql}`,
          ...params,
        );
      } catch {
        continue; // requête non rejouable telle quelle : on n'invente rien
      }
      // PIÈGE MAJEUR, trouvé en vérifiant l'outil sur les vraies données :
      // le planificateur désigne les tables par leur ALIAS (« SCAN f ») et
      // préfixe parfois le schéma (« SCAN main.AttentionState »). La première
      // version extrayait donc « f » et « main », ne les trouvait pas dans les
      // tailles, et les écartait EN SILENCE — un « SCAN m » sur les 34 877
      // lignes de Message serait passé inaperçu. C'est le faux feu vert qu'un
      // audit ne doit jamais donner.
      const alias = aliasMap(q.sql);
      for (const p of plan) {
        const m = /^SCAN (?:TABLE )?(?:"?main"?\.)?"?([A-Za-z_]\w*)"?(.*)$/.exec(p.detail ?? '');
        if (!m) continue;
        const brut = m[1];
        const table = tailles.has(brut) ? brut : (alias.get(brut) ?? brut);
        const n = tailles.get(table) ?? 0;
        if (n < 1000) continue; // balayer 6 lignes ne coûte rien
        // « USING (COVERING) INDEX » = parcours d'index, pas de table : bien
        // moins cher, on le signale mais sans crier au feu.
        const parIndex = /USING\s+(COVERING\s+)?INDEX/i.test(m[2] ?? '');
        const cle = `${s.nom}:${table}:${parIndex ? 'idx' : 'table'}`;
        if (dejaVu.has(cle)) continue;
        dejaVu.add(cle);
        out.push(
          mk({
            key: `D:service:${s.nom}:scan-${table}${parIndex ? '-idx' : ''}`,
            family: 'D',
            // La gravité tient compte du CHRONO, pas du seul plan. Un balayage
            // de 35 000 lignes qui rend en 60 ms n'est pas un problème
            // aujourd'hui — c'en devient un quand la boîte triple. Le signaler
            // « grave » alors que l'écran est instantané ferait perdre toute
            // valeur d'alerte au rapport.
            severity: parIndex
              ? 'faible'
              : ms >= 1000
                ? 'grave'
                : ms >= 300
                  ? 'moyen'
                  : 'faible',
            file: 'src/services',
            fn: s.nom,
            title: parIndex
              ? `Parcours d’index complet sur ${table} (${n.toLocaleString('fr-FR')} lignes)`
              : `Balayage complet de ${table} (${n.toLocaleString('fr-FR')} lignes)`,
            detail:
              `Le planificateur SQLite annonce « ${p.detail} »` +
              (parIndex
                ? ' : il parcourt tout un index au lieu de cibler des lignes. ' +
                  'Bien moins coûteux qu’un balayage de table, mais reste linéaire.'
                : ' : aucun index ne sert cette requête. Vérifier les colonnes du ' +
                  'WHERE et du ORDER BY — attention, un index (a, b) ne sert PAS une ' +
                  'requête qui ne filtre que sur b.') +
              `\n\n\`\`\`sql\n${q.sql.slice(0, 600)}\n\`\`\``,
            detectedBy: 'script',
            confidence: 'confirmé',
            metric: `${n.toLocaleString('fr-FR')} lignes · écran à ${ms} ms`,
          }),
        );
      }
    }
  }

  // E — compteurs censés coïncider
  try {
    const [u, r] = await Promise.all([ret.deletableUnion(), report.generateMailboxReport()]);
    const rec = (r as unknown as { recoverable?: { count?: number } }).recoverable?.count;
    if (typeof rec === 'number' && rec !== u.count) {
      out.push(
        mk({
          key: 'E:service:deletableUnion:recuperable-diverge',
          family: 'E',
          severity: 'grave',
          file: 'src/services/report.ts',
          fn: 'generateMailboxReport',
          title: 'Le « récupérable » du rapport diverge de l’union des stratégies',
          detail: `deletableUnion = ${u.count}, rapport = ${rec}. Deux écrans annoncent deux chiffres pour la même chose.`,
          detectedBy: 'script',
          confidence: 'confirmé',
          metric: `${u.count} vs ${rec}`,
        }),
      );
    }
  } catch {
    /* sonde facultative */
  }

  // Chronos toujours consignés, même sous le seuil : c'est la ligne de base
  // qui rendra un futur ralentissement visible dans le diff Git.
  const table = chronos
    .sort((a, b) => b.ms - a.ms)
    .map((c) => `| ${c.ecran} | \`${c.nom}\` | ${c.ms} ms |`)
    .join('\n');
  writeFileSync(
    chronosFile(),
    `# Chronos des écrans (dernier passage : ${now()})\n\n` +
      `Volumétrie : ${[...tailles.entries()]
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t} ${n.toLocaleString('fr-FR')}`)
        .join(' · ')}\n\n` +
      `| Écran | Service | Temps |\n|---|---|---|\n${table}\n`,
    'utf8',
  );

  await db.$disconnect();
  return out;
}

// ------------------------------------------------------------- fusion

/**
 * `statique` = la base n'a pas été interrogée à ce passage. Sans cette
 * distinction, un `--static` faisait passer TOUS les constats mesurés pour
 * « disparus » — on aurait cru avoir corrigé des balayages qu'on n'avait
 * simplement pas cherchés. Un audit ne doit jamais laisser croire cela.
 */
function fusion(
  anciens: Finding[],
  nouveaux: Finding[],
  statique = false,
): { all: Finding[]; neufs: number; disparus: number } {
  const par = new Map(anciens.map((f) => [f.key, f]));
  const t = now();
  let neufs = 0;
  for (const n of nouveaux) {
    const a = par.get(n.key);
    if (a) {
      // Tout ce qui est CALCULÉ est rafraîchi (gravité, titre, détail, mesure,
      // ligne) — sinon un constat garde éternellement la gravité d'un ancien
      // barème. Ne survivent que les trois champs qui relèvent d'une DÉCISION
      // humaine : le statut, la note, et la date de première apparition.
      par.set(n.key, { ...n, status: a.status, note: a.note, firstSeen: a.firstSeen, lastSeen: t });
    } else {
      par.set(n.key, n);
      neufs++;
    }
  }
  const vus = new Set(nouveaux.map((f) => f.key));
  let disparus = 0;
  for (const f of par.values()) {
    if (f.detectedBy !== 'script' || f.status !== 'todo' || vus.has(f.key)) continue;
    // Un constat mesuré ne « disparaît » que si on l'a réellement re-cherché.
    if (statique && f.file.startsWith('src/services')) continue;
    disparus++;
  }
  return { all: [...par.values()], neufs, disparus };
}

function rendre(all: Finding[], neufs: number, disparus: number, statique: boolean): string {
  const ouverts = all.filter((f) => f.status === 'todo');
  const parGravite = (a: Finding, b: Finding) =>
    SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
    a.family.localeCompare(b.family);

  let md = `# Audit — troncatures, listes non ouvrables, requêtes sans index\n\n`;
  md += `_Régénéré par \`npm run audit\` le ${now()}${statique ? ' (statique seulement)' : ''}._\n\n`;
  md += `**Ne pas éditer ce fichier** : il est reconstruit à chaque passage depuis\n`;
  md += `\`docs/audit-findings.json\`. Pour clore un constat, passer son \`status\` à\n`;
  md += `\`fixed\` ou \`accepted\` dans le JSON — le script ne l'écrase jamais.\n\n`;
  md += `| | |\n|---|---|\n| Constats ouverts | **${ouverts.length}** |\n`;
  md += `| Clos (corrigés ou acceptés) | ${all.length - ouverts.length} |\n`;
  md += `| Nouveaux à ce passage | ${neufs} |\n`;
  md += `| N’apparaissent plus (peut-être corrigés) | ${disparus} |\n\n`;

  md += `## Lecture\n\n`;
  md += `Les constats **confirmés** sont mesurés (chronomètre, \`EXPLAIN QUERY PLAN\`,\n`;
  md += `octet lu dans le fichier) ou relevés à la main. Ceux marqués **à vérifier**\n`;
  md += `viennent d'expressions régulières sur le front : ce sont des pistes, pas des\n`;
  md += `verdicts — certains sont des choix délibérés.\n\n`;

  for (const sev of SEVERITY_ORDER) {
    const lot = ouverts.filter((f) => f.severity === sev).sort(parGravite);
    if (!lot.length) continue;
    md += `## Gravité : ${sev} (${lot.length})\n\n`;
    for (const f of lot) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      md += `### ${FAMILIES[f.family]} — ${f.title}\n\n`;
      md += `- **Où** : \`${loc}\` · \`${f.fn}\`\n`;
      md += `- **Fiabilité** : ${f.confidence}${f.metric ? ` · ${f.metric}` : ''}\n`;
      md += `- **Clé** : \`${f.key}\`\n\n`;
      md += `${f.detail}\n\n`;
    }
  }

  const clos = all.filter((f) => f.status !== 'todo');
  if (clos.length) {
    md += `## Clos\n\n| Constat | Statut | Note |\n|---|---|---|\n`;
    for (const f of clos.sort(parGravite)) {
      md += `| ${f.title} (\`${f.fn}\`) | ${f.status} | ${f.note ?? ''} |\n`;
    }
    md += '\n';
  }
  return md;
}

// --------------------------------------------------------------- exécution

async function run(): Promise<void> {
  const { values } = parseArgs({
    options: {
      static: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  if (values.out) OUT_DIR = values.out;
  try {
    mkdirSync(join(ROOT, OUT_DIR), { recursive: true });
  } catch {
    /* déjà là */
  }

  console.log('\n=== Audit qualité — troncatures, listes, index ===\n');
  console.log(`     sortie : ${OUT_DIR}/\n`);

  console.log('1/4  Analyse statique du front et des sources…');
  const statiques = [...auditFront(), ...auditOctetsNuls()];
  console.log(`     ${statiques.length} piste(s) relevée(s).`);

  let dynamiques: Finding[] = [];
  if (values.static) {
    console.log('2/4  Analyse dynamique IGNORÉE (--static).');
  } else {
    console.log('2/4  Exécution des services sur la vraie base (chronos + EXPLAIN QUERY PLAN)…');
    try {
      dynamiques = await auditDynamique();
      console.log(`     ${dynamiques.length} constat(s) mesuré(s).`);
    } catch (err) {
      console.log(`     ⚠️ impossible : ${(err as Error).message}`);
      console.log('     (relancer avec --static si la base n’est pas disponible)');
    }
  }

  console.log('3/4  Fusion avec les constats déjà connus…');
  // Les STATUTS font autorité depuis le magasin VERSIONNÉ (`docs/`), jamais
  // depuis le dossier de sortie. Sinon un passage sur le serveur (`--out logs`)
  // repartait d'un magasin local vierge et rouvrait des constats déjà marqués
  // « corrigé » ou « faux positif » — le rapport aurait annoncé du travail déjà
  // fait. Le dossier de sortie ne reçoit que le rendu.
  let anciens: Finding[] = [];
  const sources = [join(ROOT, 'docs', 'audit-findings.json'), store()];
  for (const src of [...new Set(sources)]) {
    if (!existsSync(src)) continue;
    try {
      const lot = JSON.parse(readFileSync(src, 'utf8')) as Finding[];
      const par = new Map(anciens.map((f) => [f.key, f]));
      for (const f of lot) par.set(f.key, f);
      anciens = [...par.values()];
    } catch (err) {
      console.log(`     ⚠️ magasin illisible (${src}) : ${(err as Error).message}`);
    }
  }
  const { all, neufs, disparus } = fusion(
    anciens,
    [...statiques, ...dynamiques],
    Boolean(values.static),
  );
  const ouverts = all.filter((f) => f.status === 'todo').length;
  console.log(`     ${all.length} constat(s) au total, ${ouverts} ouvert(s), ${neufs} nouveau(x).`);

  console.log('4/4  Écriture du rapport…');
  if (values['dry-run']) {
    console.log('     (--dry-run : rien n’est écrit)');
  } else {
    all.sort((a, b) => a.key.localeCompare(b.key));
    writeFileSync(store(), JSON.stringify(all, null, 2) + '\n', 'utf8');
    writeFileSync(report(), rendre(all, neufs, disparus, values.static), 'utf8');
    console.log(`     ✅ ${OUT_DIR}/AUDIT.md et ${OUT_DIR}/audit-findings.json à jour.`);
  }

  const critiques = all.filter((f) => f.status === 'todo' && f.severity === 'critique').length;
  console.log(
    `\n${critiques ? `⚠️  ${critiques} constat(s) CRITIQUE(S) ouvert(s).` : '✅ Aucun constat critique ouvert.'}\n`,
  );
}

run().catch((err) => {
  console.error('\n❌ Audit interrompu :', (err as Error).message);
  process.exit(1);
});
