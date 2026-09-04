# Changement — suppression-un-seul-chemin

- **Date** : 2026-09-04 · **Niveau de risque** : **élevé**
- **Critères déclenchés** :
  - **(c) Sécurité / données** : c'est LE chemin de suppression des 7 boîtes
    réelles (≈ 20 000 mails sur `thony56_gtr`). Le garde-fou produit « lots de
    200 · dry-run par défaut · confirmation explicite » (`CLAUDE.md`, « Garde-fous
    NON NÉGOCIABLES ») est appliqué par le MCP (`src/mcp/tools/write.ts:172-181`)
    et absent de la route qui sert l'écran (`src/server/admin.ts:2483-2493`).
  - **(e) Réversibilité** : la corbeille rend la suppression annulable ~30 j
    côté Outlook, mais l'annulation D'UN CLIC ne dure que 10 s
    (`web/js/app.js:2206`), n'est armée que si le serveur a rendu TOUS les
    `newUids` (`admin.ts:2567-2570`) — et la route de restauration en tronque
    silencieusement au-delà de 500 (`admin.ts:2893-2901`). Au-delà de ce seuil,
    l'utilisateur croit tout récupérer et ne récupère qu'une partie.
  - **(a) Taille** : ≥ 5 fichiers, refactor traversant 3 couches (façade HTTP,
    façade MCP, services) — `write.ts`, `admin.ts`, `cleanup.ts`, `retention.ts`,
    un nouveau module `services/`, et `web/js/app.js` si un aperçu apparaît.
  - **(f) Blast radius** : une régression touche les 7 boîtes, en production
    (`https://boxmail.lb2i.com`), sur des mails que rien ne reconstruit.
  - **(g) Observabilité** : **zéro test** sur ces chemins (audit, en-tête de
    `docs/AUDIT-2026-09-03.md`) ; le seul témoin est `logs/operations.jsonl`,
    dont l'écriture est *best-effort* — un échec est loggé et avalé
    (`src/services/oplog.ts:143-149`). Une suppression non journalisée ne
    laisserait aucune trace.
- **Domaines sensibles** : **securite** (garde-fou de suppression, PII : les
  mails d'Anthony), **observation** (le journal est la seule preuve a posteriori
  qu'une suppression a eu lieu et sur quoi). PAS de `donnees-migration` (aucun
  changement de schéma Prisma) ; PAS de `deploiement-rollback` spécifique — la
  livraison reste le canal git habituel (bandeau → pull), sans étape propre à ce
  chantier.

---

## 1. Intention

- **Besoin** : ticket **A1** de `docs/AUDIT-2026-09-03.md`. Le produit annonce
  un garde-fou de suppression (« lots de 200 », « dry-run/aperçu par défaut »,
  « confirmation explicite ») et **ne l'applique que sur une des deux façades**.

  | | Plafond de l'OPÉRATION | Aperçu avant | Confirmation exigée par le serveur |
  |---|---|---|---|
  | MCP `delete_emails` / `bulk_delete_by_sender` | **200** (`write.ts:172-181`, `config.ts:122-123`) | oui, avec expéditeurs, sujets, plage de dates (`write.ts:185-206`) | oui, `confirm:true` (`write.ts:96-99`) |
  | HTTP `POST /accounts/:slug/messages/bulk` | **20 000** (`admin.ts:2489-2493`) | aucun | aucune |
  | HTTP `POST /accounts/:slug/cleanup/execute` | **20 000** (`admin.ts:3888-3893`) | côté écran seulement (modale en 2 temps, `app.js:4446-4447`) | aucune côté serveur |
  | HTTP `POST /retention/:id/apply` | **aucun** (`retention.ts:633` « pas de cap ici ») | `previewPolicy` sur une autre route (`admin.ts:1140`) | `confirm` interne, forcé à `true` par la route (`admin.ts:1164`) |

  Sur la route bulk, le 200 n'est **plus qu'une taille de lot IMAP**
  (`admin.ts:2554`), pas un plafond d'opération. Et **quatre** implémentations
  de « lots + `moveToTrash` + journal » coexistent — le ticket en annonce trois,
  il y en a une de plus (voir §3, *Inconnues*) :
  `write.ts:164-229` (`runDelete`), `cleanup.ts:449-489` (`executeSenderCleanup`),
  `retention.ts:684-708` (`applyPolicy`), `review.ts:1204-1225` (`reviewDecide`,
  plafond **500**, `review.ts:1170`).

- **Critères de succès observables** :
  1. **Un seul endroit** décide du plafond, du découpage en lots et de la forme
     de l'entrée de journal ; `grep -c "moveToTrash" src/` ne rend plus qu'un
     appelant hors `imap.ts`.
  2. Un `curl` sur la route bulk **sans** marque de confirmation rend un
     **aperçu** (compte, expéditeurs, plage de dates, sujets) et
     `logs/operations.jsonl` reçoit une ligne `dryRun:true` — aucun mail bougé.
  3. Le même `curl` **avec** la marque de confirmation supprime, et écrit **une
     seule** ligne `dryRun:false` portant la liste exacte des mails.
  4. Une demande au-dessus du plafond est **refusée avec un message qui dit quoi
     faire** (comme `write.ts:177-180`), jamais tronquée en silence — le
     `.slice(0, 20_000)` actuel supprime 20 000 mails sur une demande de 25 000
     sans le dire à personne.
  5. Le bandeau « Annuler » continue de ramener **tous** les mails quand il
     s'affiche, et **ne s'affiche pas** quand il ne le pourrait pas.
  6. Le geste quotidien d'Anthony (cocher des mails, cliquer 🗑️, 10 s pour se
     rattraper) **n'a pas régressé** : il a explicitement refusé le double clic
     le 10/08 (`app.js:2237-2239`, `app.js:10135-10138`).
  7. Le plafond est couvert par une assertion dans `npm test`.

- **Non-objectifs** :
  - **Ne pas** remplacer `alert/confirm/prompt` par des modales maison : c'est
    le ticket **C3**, et l'audit dit explicitement qu'A1 ne l'attend pas
    (« A1 sans attendre C3 », contre-revue du 03/09).
  - **Ne pas** ajouter la validation Zod des routes (**A2**) ni le middleware
    d'erreur (**A3**) — même si la route bulk lit `req.body` brut.
  - **Ne pas** traiter la CSRF (**A5**), qui est ce qui rend cette route
    atteignable depuis une autre origine. Le noter, pas le corriger ici.
  - **Ne pas** unifier `move` / `seen` / `unseen` : le chantier porte sur la
    SUPPRESSION. Le déplacement en masse partage le code de lots, il suivra.
  - **Ne pas** toucher `reviewDecide` (dépouillement) dans le même incrément si
    le temps manque : il est plafonné (500) et journalisé — il est le moins
    cassé des quatre. À traiter en dernier, ou en ticket suivant assumé.
  - **Ne pas** purger ni réécrire `logs/operations.jsonl`.

---

## 2. Carte d'impact

- **Zones touchées directement** :
  - `src/services/<nouveau>.ts` — le module commun (nom à arrêter :
    `suppression.ts`).
  - `src/mcp/tools/write.ts:164-229` — `runDelete` devient un appelant.
  - `src/server/admin.ts:2483-2598` — route bulk : plafond, aperçu, confirmation.
  - `src/services/cleanup.ts:449-489` — `executeSenderCleanup`.
  - `src/services/retention.ts:684-708` — `applyPolicy`.
  - `src/config.ts:121-124` — `limits` : le plafond d'écran est-il le même
    nombre que le plafond MCP ? (décision §4).
  - `web/js/app.js` (2 points d'appel : `:10159` boîte de réception, `:2973`
    modale « bruit ») et `web/js/api.js:247-257` (`bulkAction`) **si** l'aperçu
    remonte à l'écran.

- **Zones touchées indirectement** :
  - **`src/services/review.ts:1204-1225`** — quatrième implémentation, plafond
    **500** au lieu de 200 (`review.ts:1170`), avec son propre `undo`
    (`UndoTrashGroup`, `review.ts:1145-1151`). Elle importe `imap.js` **en
    différé et volontairement** (`review.ts:1186-1191`) : `imap.ts` tire
    `config.ts`, qui **jette** si `.env` manque (`config.ts:1`, `:44-52`) — or le
    banc `npm test` importe `review.ts`. **Toute fonction commune qui importerait
    `imap.ts` au niveau module casserait `npm test`.** C'est la contrainte
    structurante du chantier (cf. §4).
  - `src/services/report.ts:182-209` — `runGrandMenage` active puis applique les
    stratégies : il hérite de tout ce que fait `applyPolicy`.
  - `src/server/admin.ts:2888-2921` — route de restauration : **tronque
    `trashUids` ET `uids` à 500** (`:2893-2901`) et envoie jusqu'à 500 UIDs en
    **une seule** commande IMAP (`imap.ts:895-900`), alors que la règle du projet
    est « plages `a:b` ou `1:*`, JAMAIS de longues listes d'UIDs — limite
    Outlook » (`CLAUDE.md`). C'est le plafond réel de l'annulation.
  - `src/server/admin.ts:2779-2830` — suppression unitaire (`messages/actions`),
    même sémantique d'`undo`, non concernée par le plafond mais par la forme du
    journal.
  - `src/services/search.ts:985-1035` — `validateUids` (revalidation contre
    l'index, c'est LE filtre qui empêche un UID arbitraire de passer) et
    `reflectBulkInIndex` (lots de 500 — limite Prisma des 999 valeurs d'un `in`).
  - `src/services/oplog.ts:128-150` — forme des entrées ; `items` plafonné à
    20 000 (`:140`), aligné sur l'ancien plafond de sélection : si le plafond
    d'opération change, ce commentaire ment.
  - Écran **Journal** (`#/operations`, `app.js:12344`, rendu d'une ligne
    `app.js:3855-3873`) : il sait déjà afficher `dryRun` (« simulation — rien
    touché », `app.js:3871`).
  - Façade **MCP** : `delete_emails` et `bulk_delete_by_sender` sont utilisables
    depuis claude.ai — leur contrat (dry-run, message de plafond) est lu par un
    modèle, pas seulement par un humain. Changer la forme de la réponse change
    ce que Claude comprend.
  - Scénario d'usine `decision-compteur-coherent` et `tour-des-ecrans`
    (`.factory/scenarios/`) : le tour est **borné à six écrans par le rate limit**
    (60 req/min, ticket A4) — un scénario de suppression ne peut pas s'y ajouter
    naïvement.

- **Ce que le changement fait REMONTER** :
  1. **Un écran d'aperçu qui n'existait pas devient la chose qu'Anthony voit
     avant chaque mise en corbeille en lot.** Ce qu'il montrera n'a jamais été
     éprouvé à cette place. Trois choses y deviennent visibles :
     - les **sujets viendront de l'index** (`validateUids` rend `subject`/`date`,
       `search.ts:1005-1013`), pas d'IMAP : un mail déjà supprimé depuis Outlook
       apparaîtra encore dans l'aperçu tant que la sync n'est pas passée ;
     - le **compte d'écartés** (`rawUids.length - uids.length`), aujourd'hui
       renvoyé (`admin.ts:2597`) et affiché en petit après coup
       (`app.js:10166-10172`), passe AVANT la décision : il dira « 12 de tes
       mails ne sont plus dans l'index » à un moment où ça compte ;
     - l'**expéditeur dominant** de la sélection, jamais montré jusqu'ici sur ce
       chemin (le MCP le calcule déjà, `imap.ts:962-975`).
  2. **Le journal reçoit des lignes `dryRun:true` venues de l'interface**, ce
     qu'il n'a jamais eu (seul le MCP en produit aujourd'hui,
     `write.ts:187-195`). Le badge existe (`app.js:3871`) — vérifié —, mais le
     compteur de l'écran Journal et les filtres (`[data-ops-filter]`,
     `app.js:12355`) vont voir leur volume doubler pour chaque suppression.
     À vérifier : que le filtre ne mélange pas simulations et actes.
  3. **Le plafond, en devenant un refus explicite, rend visible un usage
     jusque-là silencieux** : si Anthony coche régulièrement plus de N mails,
     il le découvrira le jour de la livraison. Mesurer avant (cf. §5) :
     `logs/operations.jsonl` porte `params.count` pour chaque `ui_bulk_delete`.

- **Invariants** (formulés en CONDITION) :
  1. **I1** — Une mise en corbeille en lot part **seulement après** un geste qui
     désigne les mails et une voie de retour armée : soit une confirmation
     serveur adossée à un aperçu, soit la sélection explicite d'un écran + le
     bandeau « Annuler ».
  2. **I2** — Une opération de suppression touche IMAP **seulement par lots d'au
     plus `config.limits.maxDeletePerCall` UIDs**, quel que soit le nombre
     demandé.
  3. **I3** — Une demande au-dessus du plafond d'opération est **refusée avec un
     message nommant le plafond et la découpe à faire** ; elle est exécutée
     partiellement **seulement si** l'appelant l'a redemandée explicitement.
  4. **I4** — Une suppression est écrite dans `logs/operations.jsonl` **en une
     seule entrée par opération**, portant la liste exacte des mails, **y compris
     quand un lot échoue en cours** — modèle : le `finally` de
     `cleanup.ts:463-489`.
  5. **I5** — L'index local passe à `isDeleted` **seulement pour les mails dont
     le serveur IMAP a accusé le déplacement**.
  6. **I6** — Le bandeau « Annuler » s'affiche **seulement si** tous les
     `newUids` ont été rendus **et** que la route de restauration peut tous les
     reprendre (aujourd'hui : ≤ 500, `admin.ts:2893-2901`).
  7. **I7** — Une suppression est un déplacement vers la corbeille **et
     seulement cela** (`imap.ts:904-915`) ; les mails touchés sont **seulement**
     ceux revalidés contre l'index pour ce compte et ce dossier
     (`search.ts:985-1014`).

---

## 2bis. Surfaces utilisateur

- **Comportements du catalogue applicables** : à instruire par la session
  d'implémentation (`C:\Projects\claude-dev-config\produit\`, non accessible
  depuis cette session de cadrage). Trois familles pertinentes a priori :
  *action longue qui rend compte*, *collection triable/filtrable/en lot*,
  *états distincts dont resynchronisation après action*. Le **SOCLE UI**
  s'applique d'office.
- **Parcours clés** — à valider avec Anthony **avant** d'écrire une ligne :
  1. « Je coche 12 pubs et je les jette » → il coche, clique 🗑️, **rien ne
     change** par rapport à aujourd'hui (départ immédiat + bandeau 10 s). C'est
     le parcours à NE PAS abîmer.
  2. « Je coche 400 mails » → il coche, clique 🗑️, **un aperçu s'ouvre** :
     « 400 mails, de 6 expéditeurs, du 12/03/2019 au 02/08/2026 — 12 ne sont
     plus dans l'index » + les 10 premiers sujets + un bouton
     « Mettre les 400 à la corbeille ». Le bandeau d'annulation ne s'affichera
     pas au-delà de ce que la restauration sait reprendre — il est remplacé par
     « récupérables ~30 j dans Outlook », comme le fait déjà `offerUndoDelete`
     (`app.js:2242-2247`).
  3. « Je me suis trompé » → dans les 10 s, « ↩️ Annuler » ramène **tout** ; au
     delà, la corbeille Outlook.
  4. « Qu'est-ce que j'ai supprimé hier ? » → `#/operations`, une ligne par
     opération, la liste dépliable des mails, et les simulations distinguées.
- **Validés avec l'utilisateur le** : **PAS ENCORE.** Le seuil (parcours 2) et
  la question « aperçu obligatoire au-dessus de combien ? » sont une décision
  d'Anthony (§4), pas un choix technique.
- **Rodage prévu** : 2 boucles de retours budgétées après livraison, sur ses
  boîtes réelles, sur des sélections qu'il choisit lui-même.

---

## 3. Inconnues & hypothèses

- **Inconnues**
  - **Le seuil.** À partir de combien de mails un aperçu vaut mieux qu'un
    bandeau ? 200 (le plafond MCP) casserait un geste courant si Anthony coche
    souvent 300 pubs. **Mesurable avant de coder** : `params.count` des lignes
    `ui_bulk_delete` de `logs/operations.jsonl` **sur le serveur** — la
    distribution réelle de ses sélections. À faire en début de session
    d'implémentation.
  - **Le plafond dur d'opération.** Le MCP refuse au-delà de 200 parce qu'un
    modèle peut se tromper de sélection. Un humain qui a coché 3 000 mails
    ne s'est pas trompé de la même façon. Deux nombres différents (`maxDeletePerCall`
    pour le MCP, `maxDeletePerOperationUi` pour l'écran) sont défendables — mais
    « deux plafonds » redevient « deux chemins », ce que ce ticket combat.
  - **Le ticket annonce trois implémentations ; il y en a quatre.**
    `reviewDecide` (`review.ts:1204-1225`) est la quatrième, avec un plafond de
    **500** (`review.ts:1170`) et un `undo` à elle. À arbitrer : la faire entrer
    dans le chantier, ou l'assumer comme ticket suivant (elle est plafonnée et
    journalisée — la moins urgente).
  - **La restauration tronque à 500 sans le dire** (`admin.ts:2893-2901`) et le
    front n'en tient pas compte : `offerUndoDelete` (`app.js:2242`) passe le
    groupe complet, `showUndoToast` ne lit pas `restored` (`app.js:2223-2235`).
    Une annulation de 800 mails en restaurerait 500 et afficherait un succès.
    **Ce défaut est hors du texte du ticket A1** ; il est dans son périmètre
    d'invariant (I6). À corriger ici, ou à ouvrir séparément — mais pas à
    ignorer, sinon I6 reste faux après le chantier.
  - **Combien d'UIDs Outlook accepte-t-il dans une commande `UID MOVE` ?**
    200 est la valeur d'usage partout, 500 dans la restauration, 1 000 accepté
    par le MCP `move_emails` (`write.ts:9-13` → `imap.ts:847-862`, **sans
    découpage**). Aucune mesure au dossier. Le chantier ne le mesurera pas : il
    ramènera tout le monde à 200.
  - **Compte de test.** Y a-t-il une boîte jetable pour prouver le chemin
    confirmé de bout en bout ? Sinon la preuve « avec confirmation → journal »
    se fait sur une boîte réelle, sur 2-3 mails désignés par Anthony.

- **Hypothèses**
  - L'aperçu se construit **depuis l'index**, pas depuis IMAP : `validateUids`
    rend déjà sujets et dates (`search.ts:1005-1013`). Conséquence forte : le
    chemin d'aperçu **n'a besoin ni d'IMAP ni de `accounts.json`** s'il rend sa
    réponse **avant** `resolveAccount` (aujourd'hui appelé en `admin.ts:2512`).
    Il devient donc **testable par `curl` en dev sur `npm run seed:dev`**, ce
    qu'aucune preuve de suppression n'est aujourd'hui.
    (Le MCP, lui, paie un `imapService.summarize` avant même de savoir s'il est
    en dry-run — `write.ts:185`. Ne pas reproduire ça côté écran.)
  - COPYUID (RFC 4315) est rendu par Outlook pour un lot de 200 : c'est ce qui
    fait marcher le bandeau aujourd'hui (`imap.ts:841-862`). Non mesuré au-delà.
  - `npm test` (= `verdict:check`, `src/cli/verdict-check.ts`) reste le seul
    harnais de test du dépôt, et il est **pur** : ni `.env`, ni base, ni réseau
    (en-tête du fichier, `:34-40`). Toute preuve unitaire du plafond doit tenir
    dans ce cadre.
  - Aucun autre client n'appelle la route bulk : les deux seuls appelants sont
    `app.js:10159` et `app.js:2973`, via `api.js:247-257`. Vérifié par `grep`.

---

## 4. Décision

### Options

**Option A — Une fonction de service qui fait tout (plafond, lots, IMAP, journal)**

`services/suppression.ts` expose
`supprimerEnLots({ rec, folder, uids, confirm, tool, params, items })` qui
plafonne, découpe en lots de 200, appelle `imapService.moveToTrash`, accumule,
journalise en `finally`, et **rend** `{ moved, batches, destination, newUids,
echecs }`. Elle ne touche **ni l'index ni l'`undo`** : chaque façade garde son
`reflectBulkInIndex` et construit son `undo` à partir des `newUids` rendus —
c'est exactement ce que le piège de contre-revue exige.

- *Ce que ça coûte* : elle importe `imap.ts` au niveau module → elle tire
  `config.ts` → **`npm test` ne peut pas l'importer** (`review.ts:1186-1191`
  documente précisément ce piège). Le « test unitaire du cap » demandé par le
  ticket devient impossible avec l'outillage existant ; il faudrait soit
  installer un vrai runner (hors périmètre, c'est une décision d'outillage),
  soit prouver le plafond uniquement par `curl`.
- *Undo / `reflectBulkInIndex`* : préservés, restent chez l'appelant. ✔

**Option B — Un noyau pur + un exécuteur mince (mouvement injecté)**

Deux étages dans `services/suppression.ts` :
1. `planifierSuppression(uids, { cap, taillePaquet })` → `{ refuse, raison, lots }`.
   **Fonction pure** : ni `.env`, ni base, ni réseau. Importable par
   `verdict:check` → le plafond, le message de refus et le découpage sont
   couverts par `npm test`, le harnais qui existe déjà (175 assertions
   branchées le 04/09).
2. `executerSuppression(plan, { deplacer, journaliser })` où `deplacer` est
   **injecté** : `(folder, lot) => Promise<{ moved, destination, newUids }>`.
   En production c'est `imapService.moveToTrash` ; au banc, un faux déplaceur.
   Rend `newUids` **alignés sur l'ordre des `uids` d'entrée** et la liste des
   lots en échec ; journalise une entrée unique en `finally`.

- *Ce que ça coûte* : deux niveaux au lieu d'un, et une injection à câbler dans
  quatre appelants — plus de cérémonie pour un lecteur pressé.
- *Ce que ça rapporte* : le module commun **n'importe pas `imap.ts`**, donc pas
  de piège `config.ts` ; le chemin d'échec partiel (aujourd'hui perdu par la
  route bulk : un `throw` en cours de lots ne journalise **rien** et ne met pas
  l'index à jour, `admin.ts:2554-2596`) devient reproductible au banc avec un
  faux déplaceur qui échoue au 3ᵉ lot. C'est la seule option où **I4 se prouve**.
- *Undo / `reflectBulkInIndex`* : préservés, restent chez l'appelant. ✔

**Option C — Ne factoriser que la politique, pas l'exécution**

Extraire uniquement `assertPlafond(uids)` + un `journaliserSuppression(...)`
commun, et laisser les quatre boucles de lots là où elles sont.

- *Ce que ça coûte* : ne règle pas ce que le ticket nomme (« trois
  implémentations coexistent »), et le prochain chemin de suppression en créera
  une cinquième.
- *Ce que ça rapporte* : intervention minimale sur un chemin irréversible, zéro
  risque sur l'`undo` (aucune ligne d'`undo` n'est déplacée), livrable en une
  demi-session. C'est le repli si la contre-revue juge B trop ambitieux pour un
  chemin de suppression sans filet de test.

### Décision

**Option B**, pour une raison décisive et sourcée : le ticket exige un « test
unitaire du cap », et **le seul harnais du dépôt est un banc de fonctions pures
qui ne peut pas charger `config.ts`** (`verdict-check.ts:34-40`,
`config.ts:1,44-52`, contournement documenté `review.ts:1186-1191`). L'option A
rend cette preuve impossible sans installer un runner ; l'option C ne supprime
pas la duplication. B est la seule qui livre à la fois **un seul chemin** et
**une preuve mécanique du garde-fou** — sur un chemin qui n'en a aucune
aujourd'hui.

Deux points restent à trancher **avec Anthony avant de coder** (ce ne sont pas
des choix techniques) :
- **le seuil d'aperçu** côté écran (à éclairer par la distribution réelle des
  `params.count`, cf. §3) ;
- **un plafond ou deux** : même nombre pour le MCP et l'écran, ou deux nombres
  assumés et nommés.

Repli assumé : si la contre-revue estime que réécrire quatre appelants d'un coup
est trop pour une session, livrer **C d'abord** (plafond + journal communs,
route bulk avec aperçu et confirmation) et **B ensuite** — dans cet ordre, parce
que le trou de sécurité est la route, pas la duplication.

- **Contre-revue** : **NON FAITE.** Cette session est en lecture seule et n'a pas
  le droit de lancer l'usine ni un outil externe. Le protocole aveugle
  (`/consult`) est **exigé avant la première ligne de code** par le niveau élevé.
  Élément déjà acquis : la contre-revue Codex du 03/09 a relevé le piège de
  l'`undo` (repris ici en I6 et dans les trois options).
- **ADR** : **oui** — `docs/adr/0001-un-seul-chemin-de-suppression.md` (le dossier
  `docs/adr/` n'existe pas encore). Ce qui mérite une mémoire longue : *pourquoi
  l'écran a un contrat différent du MCP* (un humain qui coche n'est pas un modèle
  qui devine), *où vit le plafond*, et *pourquoi le mouvement IMAP est injecté*
  (sans quoi le garde-fou n'est pas testable). Conditions de réouverture : le
  jour où le dépôt se dote d'un vrai runner de tests, ou le jour où un troisième
  client (Fiscal-Manager, une automatisation) veut supprimer.

---

## 5. Plan de preuve

> Contexte : **pas d'IMAP réel en dev** (`CLAUDE.md`). Les preuves se répartissent
> en trois bancs : (1) fonctions pures dans `npm test`, (2) `curl` en local sur
> `npm run seed:dev` — possible **seulement** pour le chemin d'aperçu, qui n'a
> besoin ni d'IMAP ni de `accounts.json`, (3) un faux déplaceur pour l'exécution.
> Le chemin réellement confirmé sur une boîte réelle est validé **par Anthony**.

### Conformité

- **P1** — `npm test` : `planifierSuppression` découpe 1 000 UIDs en 5 lots de
  200 ; 201 UIDs → 2 lots (200 + 1) ; 0 UID → refus explicite.
- **P2** — `curl -X POST /api/accounts/demo_perso/messages/bulk` avec
  `action:"delete"`, sans marque de confirmation → HTTP 200, corps portant
  `apercu:true`, le compte, les expéditeurs, la plage de dates ; **et**
  `logs/operations.jsonl` gagne **une** ligne `dryRun:true`.
  *Contrôle négatif* : `wc -l` de la base de messages inchangé, aucune ligne
  `isDeleted` modifiée (`sqlite` avant/après).
- **P3** — même `curl` **avec** la marque de confirmation, sur un compte de test
  monté avec un faux déplaceur (banc `node --import tsx`) → une ligne
  `dryRun:false` avec `items` = liste exacte, `affectedUids` complet,
  `result: "soft-deleted N -> <corbeille>"`.
- **P4** — `curl` avec un nombre d'UIDs au-dessus du plafond → **refus** (statut
  et message nommant le plafond), `logs/operations.jsonl` inchangé, aucun mail
  bougé. Le message contient le nombre demandé, le plafond, et la découpe
  suggérée (calqué sur `write.ts:177-180`).
- **P5** — façade MCP inchangée dans son contrat : `delete_emails` avec 201 UIDs
  rend toujours `blocked:true` + le même message ; avec 5 UIDs et sans `confirm`,
  toujours `dryRun:true` + `wouldDelete`.
- **P6** — `factory verify --all` (les 3 scénarios existants) au vert, sur le
  serveur local `PORT=8799` — c'est la non-régression d'écran.
- **P7** — **capture d'écran obligatoire** de l'aperçu et du bandeau (règle
  `CLAUDE.md` : « Capture obligatoire avant de livrer un écran »), plus une
  capture du Journal montrant une ligne « simulation — rien touché » à côté d'une
  ligne réelle.

### Non-régression (contre les zones indirectes de la carte)

- **N1** — `npm run typecheck` (couvre `src/` **et** `web/` via
  `tsconfig.web.json`) + `node --check web/js/*.js`.
- **N2** — Rétention : `POST /retention/:id/preview` rend le même `matched`
  qu'avant le chantier sur la base de seed (comparaison avant/après, chiffre
  noté ici en §6). `runGrandMenage` passe par `applyPolicy` : le vérifier par
  lecture du diff, pas par exécution.
- **N3** — `executeSenderCleanup` : le `finally` de journalisation
  (`cleanup.ts:463-489`) doit rester le comportement, pas devenir une victime de
  la factorisation — banc avec faux déplaceur qui échoue au 2ᵉ lot.
- **N4** — `reviewDecide` : si elle n'entre pas dans le chantier, vérifier
  qu'elle n'a **pas** été touchée (`git diff --stat` doit ne pas la citer) ; si
  elle y entre, son import différé de `imap.js` doit survivre — preuve :
  `npm test` passe (il importe `review.ts`).
- **N5** — `web/js/api.js` : `bulkAction` garde une signature compatible avec ses
  deux appelants (`app.js:10159`, `app.js:2973`).

### Invariants — un contrôle ET une preuve positive pour chacun

| # | Contrôle (l'invariant tient) | **Preuve positive** (la capacité existe toujours) |
|---|---|---|
| **I1** | Un `curl` bulk sans marque de confirmation ne bouge aucun mail (P2) ; l'index est inchangé. | **Un `curl` bulk AVEC la marque supprime réellement et le journal le montre (P3).** Et à l'écran : cocher 5 mails + clic 🗑️ part **au premier clic** (capture P7) — sans cette preuve, on aurait remplacé un garde-fou par la disparition du bouton, exactement l'incident du 18/08. |
| **I2** | Banc : 1 000 UIDs → le faux déplaceur est appelé 5 fois, avec 200 UIDs à chaque fois, jamais plus. | **Une suppression de 250 mails aboutit** (2 appels, 250 mails déplacés) — le lot n'est pas devenu un plafond déguisé. |
| **I3** | P4 : au-dessus du plafond → refus, rien touché, rien tronqué. | **Une demande exactement AU plafond passe** et supprime tout : la limite est une frontière, pas une zone morte. |
| **I4** | Banc : le faux déplaceur échoue au 3ᵉ lot sur 5 → **une** entrée de journal existe, portant les 400 mails réellement déplacés, et **ni plus ni moins**. | **Un cas nominal écrit exactement UNE entrée** pour 1 000 mails en 5 lots (pas 5 entrées) — le journal reste une opération, pas un lot. |
| **I5** | Après l'échec au 3ᵉ lot : `isDeleted` vaut vrai pour les 400 premiers et **faux** pour les 600 autres. | **Après un succès complet, les 1 000 sont à `isDeleted` vrai** et le compteur du dossier a suivi — sinon on aurait « protégé » l'index en ne l'écrivant plus. |
| **I6** | Un faux déplaceur qui ne rend `newUids` que pour 3 lots sur 5 → la réponse **ne porte pas** d'`undo` ; l'écran affiche « récupérables ~30 j » sans bouton (`app.js:2244-2246`). Et : une suppression de 600 mails ne propose pas d'annulation d'un clic tant que la restauration tronque à 500 (`admin.ts:2893-2901`). | **Une suppression de 40 mails propose le bouton, et le clic ramène les 40** — vérifié par le compteur `restored` de la réponse **et** par la liste rechargée. C'est le seul cas qui prouve que l'annulation existe encore. |
| **I7** | `grep -n "messageDelete\|EXPUNGE\|\\\\\\\\Deleted" src/` reste vide hors commentaires ; le faux déplaceur n'est appelé qu'avec le dossier corbeille en destination. Un UID absent de l'index est écarté et **compté** dans la réponse. | **Un UID présent dans l'index passe** et est supprimé (P3) — la revalidation filtre, elle ne bloque pas tout. |

### Rodage

Une session d'usage réel avec Anthony après livraison : il fait deux
suppressions qu'il aurait faites de toute façon (une petite, une grosse), et on
regarde ensemble le Journal. 2 boucles de retours budgétées.

---

## 6. Preuves exécutées

*(vide — à remplir par la session d'implémentation, avant le commit)*

- **Résultats** :
- **Diff réel ↔ carte d'impact** :
- **Divergences vs plan** :

---

## 7. Mise en service & observation

- **Déploiement** : canal habituel — commit + push sur `main`, bandeau sur le
  tableau de bord, Anthony clique, `scripts/supervisor.mjs` fait pull → install →
  `db:setup` → build → serveur. Côté serveur : `boxmail-update.timer` à 04:00
  UTC. **Aucune migration de schéma** dans ce chantier : rien à appliquer au
  boot, `db:generate` seul.
- **Rollback** : `git revert` du commit + relance. Le superviseur Windows sait
  désormais revenir sur le commit précédent si le build casse (chantier
  `2026-09-04-rollback-supervisor`) — mais ce chantier-ci casse à l'exécution,
  pas au build : le retour se fait à la main, par revert.
  **Point d'attention** : un rollback ne rend AUCUN mail. Ce qui est parti à la
  corbeille y reste (récupérable ~30 j côté Outlook). Le rollback protège le
  comportement futur, jamais le passé — d'où l'insistance de §5 sur les bancs
  avant livraison.
- **Signaux à observer** (7 jours après la mise en service) :
  1. `logs/operations.jsonl` **sur le serveur** : le ratio lignes `dryRun:true` /
     `dryRun:false` sur les outils `ui_bulk_delete`. Une explosion de simulations
     sans acte = l'aperçu gêne au lieu d'aider (seuil trop bas).
  2. La distribution de `params.count` : si des refus au plafond apparaissent,
     le nombre est mal choisi — le corriger, ne pas laisser Anthony contourner.
  3. Les entrées d'annulation (`ui_restore_message`) : leur nombre et surtout
     l'écart entre `params.count` et le nombre supprimé de l'opération d'avant —
     c'est le détecteur de la troncature à 500 (I6).
  4. `npm run charge` avant / après : ce chantier **ne doit pas** faire monter le
     nombre de décisions demandées pour 100 mails reçus. Un aperçu de plus n'est
     pas une décision de plus s'il remplace une inquiétude.
  5. **Le contrôle qu'aucun compteur ne donne** : relire, une fois, la liste
     complète d'une opération réelle dans le Journal, et vérifier qu'aucun mail
     porteur d'un document ne s'y trouve. « Regarder un compteur ne remplace pas
     lire la liste » (`CLAUDE.md`) — c'est aussi la garantie « 0 mail personnel ».
- **Clôture** : *(date + « signaux normaux, aucune action ouverte »)*
