# Changement — rollback-supervisor

- **Date** : 2026-09-04 · **Niveau de risque** : **moyen**
- **Critères déclenchés** :
  - **(c) Chemin critique** : `scripts/supervisor.mjs` EST le canal de
    livraison du poste d'Anthony — c'est lui que `MailAssistant.bat` lance au
    double-clic. Tout ce qu'il fait mal se voit une fois par jour, et se voit
    d'abord sous la forme d'une fenêtre noire.
  - **(d) Rattrapage impossible sans compétence** : l'utilisateur est non
    technique et PowerShell lui est banni (`CLAUDE.md`, « L'utilisateur »). Un
    échec dont il ne peut pas sortir SEUL est un échec total, pas un incident.
- **Domaines sensibles** : **deploiement-rollback** (c'est le sujet même du
  ticket). Aucun secret, aucune migration, aucun envoi : les migrations restent
  appliquées par le serveur à son démarrage (`src/db/migrate.ts`), jamais ici.

## 1. Intention

- **Besoin** : ticket **D3** de `docs/AUDIT-2026-09-03.md`. Le superviseur
  Windows boucle dans un `for(;;)` : un échec de `npm install`, de
  `db:generate` ou de `build` provoque `sleep(15 s)` + `continue`, **sans
  limite de tentatives et sans message actionnable** (`supervisor.mjs:79-83,
  91-95, 108-115` avant ce chantier). Côté Linux, `deploy/update.sh:118-135`
  fait l'inverse : il mémorise `PREV`, revient dessus, recompile, et écrit
  `logs/update-status.json` que ⚙️ Paramètres affiche déjà
  (`services/autoupdate.ts:72-94` → `web/js/app.js:8381`). Pour Anthony, un
  commit cassé poussé le soir = une fenêtre noire qui boucle indéfiniment
  jusqu'à ce qu'il pense à appeler. Il faut porter ce filet côté Windows.
- **Critères de succès observables** :
  - un commit cassé (build qui échoue) fait revenir le poste sur le commit
    précédent, reconstruire, et démarrer le serveur — l'appli marche ;
  - ⚙️ Paramètres affiche « échec … retour sur `abc1234` » avec le détail ;
  - la fenêtre noire porte un bloc en français disant ce qui a échoué et quoi
    faire — jamais une répétition muette de la même erreur ;
  - le cas nominal ne change pas : mêmes étapes conditionnelles, mêmes sauts.
- **Non-objectifs** :
  - ne PAS traiter le commit qui **compile mais fait planter le serveur au
    démarrage** (boucle « démarrage → crash → 3 s → démarrage ») : même
    famille, mais un plantage runtime peut être transitoire (port occupé, base
    verrouillée) et décider d'un retour en arrière là-dessus demande son propre
    cadrage. Signalé comme ticket suivant ;
  - ne pas toucher `deploy/update.sh` (référence, LU seulement), ni `src/`, ni
    `web/`, ni `package.json` — trois agents travaillent dans le même arbre ;
  - ne pas remplacer le libellé « gérée par le minuteur du serveur (hors
    application) » que l'interface affiche pour un statut externe (il vit dans
    `web/js/app.js`, hors périmètre).

## 2. Carte d'impact

- **Zones touchées directement** : `scripts/supervisor.mjs` — et lui seul.
- **Zones touchées indirectement** :
  - `logs/update-status.json` : fichier **déjà lu** par
    `src/services/autoupdate.ts:59,72-94`, jusqu'ici écrit uniquement par
    `deploy/update.sh` sur le serveur Linux. Le superviseur devient un second
    écrivain, sur une AUTRE machine (le poste Windows). `logs/` est gitignoré :
    aucun fichier n'entre au dépôt. Marqueur `source:"supervisor"` ajouté pour
    que le superviseur n'efface jamais un statut qu'il n'a pas écrit.
  - ⚙️ Paramètres (`web/js/app.js:8381-8400`) : jusqu'ici, sur le poste, ce
    bloc affichait « ✕ désactivée — ici, la mise à jour se fait au lancement ».
    Dès qu'un statut existe, il affichera « ⚠️ … dernier passage … : échec » +
    le message complet. C'est l'effet recherché.
  - `MailAssistant.bat` : inchangé (« ne sera plus jamais modifié »). Son
    `pause` final est ce qui rend lisible une sortie du superviseur.
- **Ce que le changement fait REMONTER** : le bloc ⚙️ Paramètres du poste
  Windows, aujourd'hui inerte, devient parlant. Vérifié que le chemin complet
  fonctionne : `autoupdate.ts` accepte exactement les trois valeurs `à jour` /
  `mis à jour` / `échec` (`RESULTS`, ligne 61-65) — toute autre valeur rendrait
  `lastResult: null` et l'écran dirait « aucun passage encore ». Le statut écrit
  ici n'utilise que ces trois valeurs.
- **Invariants** :
  - Le superviseur démarre le serveur **seulement après** que les trois étapes
    de préparation ont réussi, ou après un retour en arrière assumé, ou sur un
    `dist/index.js` existant **avec** un message d'échec affiché ET écrit.
  - Une étape échouée est réessayée **seulement dans la limite de 2
    tentatives** sur un même commit ; au-delà, le superviseur change d'état
    (retour en arrière, ou sortie expliquée) — il ne re-boucle plus à
    l'identique.
  - Le retour en arrière n'a lieu **que si** le `git pull` a effectivement
    changé de commit **et** que l'arbre de travail est sans modification locale
    suivie — sinon on est sur un poste de développement et on ne détruit rien.
  - Le superviseur efface `logs/update-status.json` **seulement si** ce fichier
    porte `source:"supervisor"` — le statut du serveur Linux lui est étranger.
  - Toute sortie du superviseur se fait **seulement après** avoir affiché un
    bloc en français nommant l'étape en échec et l'action à faire.

## 3. Inconnues & hypothèses

- **Inconnues** :
  - le libellé « gérée par le minuteur du serveur (hors application) » sera
    affiché sur le poste, ce qui est faux au mot près (il n'y a pas de minuteur
    sur le PC). Le reste de la ligne — ⚠️, « échec », le message complet — est
    juste. Corriger le libellé demande `web/js/app.js` : hors périmètre, noté
    comme ticket suivant.
  - après un retour en arrière, si la nouveauté avait déjà fait appliquer une
    migration de base, le `dist` de la veille tourne sur un schéma en avance.
    `deploy/update.sh` accepte déjà exactement ce risque (même séquence) ; le
    filet réel reste la sauvegarde `backups/`.
- **Hypothèses** :
  - `git reset --hard <commit>` est acceptable sur le poste d'Anthony : il n'y
    développe pas, `git status` y est propre. L'invariant « seulement si arbre
    propre » transforme cette hypothèse en condition vérifiée à l'exécution.
  - Passer `npm install` / `tsc` de `stdio: 'inherit'` à des tuyaux réémis vers
    la console garde l'affichage vivant (perte attendue : la barre de
    progression npm, qui ne se dessine que sur un vrai terminal). C'est le prix
    pour capturer le détail de l'échec — même technique que
    `services/autoupdate.ts:105-120`.

## 5. Plan de preuve

Le vrai dépôt ne peut pas servir de banc (interdiction de toucher à l'index
git, deux autres agents dans l'arbre). Banc jetable : un dépôt git temporaire,
deux commits, une copie du superviseur modifié, un `package.json` minimal dont
les scripts sont pilotables.

- **Conformité** :
  1. **Cas nominal** : le commit neuf compile → aucun retour en arrière, aucun
     statut d'échec, le « serveur » démarre.
  2. **Cas cassé** : le commit neuf a un `build` qui échoue → 2 tentatives, puis
     `git reset --hard` sur le commit d'avant, reconstruction, statut
     `logs/update-status.json` = `échec` + message citant le commit court, bloc
     lisible à l'écran, et le serveur démarre quand même.
- **Non-régression** :
  - `node --check scripts/supervisor.mjs` dans le vrai dépôt ;
  - relecture du chemin nominal : les trois sauts conditionnels (« Dépendances
    inchangées », « Schéma de base inchangé », « Code serveur inchangé »)
    doivent apparaître au second passage du banc, preuve que l'état
    `node_modules/.mailassistant-state.json` fonctionne toujours ;
  - `logs/` reste gitignoré, `git status` du vrai dépôt inchangé côté suivi.
- **Invariants** :
  - « 2 tentatives puis changement d'état » : compter les occurrences de la
    ligne `$ npm run build` dans la sortie du banc cassé — 2 avant le retour,
    1 après (reconstruction), soit 3 au total, pas 4, pas l'infini.
  - **Preuve positive** de l'invariant « retour seulement si le pull a changé
    de commit » : un banc où le build échoue SANS nouveauté ne doit PAS faire
    de `git reset` (sinon on aurait supprimé la capacité au lieu de la
    conditionner) — il doit sortir avec le bloc lisible.
  - **Preuve positive** de l'invariant « efface seulement son propre statut » :
    déposer un `update-status.json` sans `source` avant un passage réussi et
    vérifier qu'il est toujours là après.

## 6. Preuves exécutées

Banc jetable monté hors du dépôt (interdiction de toucher à l'index git,
trois agents dans l'arbre) : un dépôt nu + un clone « dev » qui pousse + un
clone « poste » où tourne une COPIE du superviseur modifié, sur un faux projet
dont le `build` est pilotable. Script et journal complet dans le dossier
temporaire de session (`banc.mjs`, `banc-sortie.log`). Cinq scénarios, tous
exécutés d'un seul jet :

| Scénario | Attendu | Résultat réel |
|---|---|---|
| **A** — commit sain | démarre, aucun retour, aucun statut posé | `HEAD = 20b912e / marque = v2`, statut inchangé, 2,2 s |
| **E** — rien de neuf | les 3 étapes sautées (non-régression) | `étapes sautées : 3 sur 3`, 1,0 s |
| **B** — commit cassé | 2 tentatives, retour, reconstruction, statut | `HEAD 20b912e (= v2)`, `compilations lancées : 3`, statut `échec` + « retour sur 20b912e », serveur démarré sur v2, 18,7 s |
| **C** — cassé SANS nouveauté | pas de `git reset`, sortie expliquée | `git reset lancé : non`, `superviseur sorti (code 1)`, bloc ⛔ affiché |
| **D** — cassé AVEC travail local | pas de `git reset`, travail intact | `git reset lancé : non`, `tsconfig.json` local intact, fichier NOMMÉ à l'écran, serveur démarré sur l'ancien `dist` |

- **Statut lu comme le serveur le lit** (réplique de `autoupdate.ts:61-94`
  appliquée au fichier écrit au banc) : `lastResult : "échec"` — donc `⚠️` à
  l'écran, message de 493 car. replié dans `<details>` comme prévu par
  `app.js:8396-8400`. Le rendu de l'écran lui-même n'est PAS prouvé (serveur
  local interdit ce jour, `web/` et `src/` hors périmètre).
- **`node --check scripts/supervisor.mjs`** → `OK` (vrai dépôt).
- **Deux défauts trouvés par le banc, pas par la relecture** :
  1. `npm install` renormalise parfois `package-lock.json` ; le garde-fou
     « arbre propre » désactivait alors le retour en arrière EN SILENCE.
     `package-lock.json` est désormais exclu du garde-fou.
  2. `gitOut()` fait `trim()`, ce qui rogne l'espace de tête de la première
     ligne de `git status --porcelain` : un découpage par position affichait
     « sconfig.json ». Remplacé par un motif d'état.
- **Diff réel ↔ carte d'impact** : conforme. Un seul fichier suivi modifié
  (`scripts/supervisor.mjs`, +268/−29) plus ce dossier `.chantier/`.
  `logs/update-status.json` n'entre pas au dépôt (`logs/` gitignoré).
- **Divergences vs plan** : le garde-fou anti-destruction a été DURCI en cours
  de route (exclusion du lock + fichiers nommés à l'écran) parce que le banc a
  montré qu'il pouvait annuler tout le chantier sans le dire. Reste hors
  périmètre et à ouvrir en ticket : le libellé « gérée par le minuteur du
  serveur » affiché sur le poste, et le commit cassé qui sera re-tiré à chaque
  redémarrage (aucune mémoire des commits déjà jugés cassés).
