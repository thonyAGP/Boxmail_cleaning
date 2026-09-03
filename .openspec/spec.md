# Boxmail — OpenSpec

> **Ce fichier est un INDEX, pas la source de vérité.** Boxmail documentait déjà
> son travail avant l'arrivée d'OpenSpec (23/08/2026), et dupliquer cette
> matière ici la ferait diverger. Les documents qui font foi :
>
> | Document | Rôle |
> |---|---|
> | `CLAUDE.md` | Constitution du projet + « État courant » (< 10 Ko obligatoire) |
> | `docs/JOURNAL.md` | Compte rendu détaillé de CHAQUE session, du plus récent au plus ancien |
> | `docs/ROADMAP.md` | Plan |
> | `docs/PLAN-ASSISTANT.md` | Cadre de la refonte de l'analyse |
> | `docs/BANC.md` | Méthode de mesure |

## Vue d'ensemble

Assistant email personnel multi-boîtes pour comptes Outlook.com/Hotmail
personnels (refusés par le connecteur M365 officiel de Claude). Deux façades sur
les mêmes services : un **serveur MCP distant** (52 tools, l'analyse IA se fait
sur le forfait Claude de l'utilisateur — pas de clé API côté serveur) et une
**interface web** sur `/admin`, utilisée quotidiennement.

Utilisateur unique, **non technique** : tout passe par l'interface, jamais par
une ligne de commande. Livraison par bandeau de mise à jour sur le tableau de
bord → d'où la règle : **pousser après chaque passe fonctionnelle**.

**Cap produit (11/08) : « RETROUVER SANS CLASSER »** — ses ~41 000 mails sont
des archives non structurées, pas des boîtes sales. Le produit doit aider à
retrouver, pas à ranger.

## Architecture

Node/TypeScript · Express · **SQLite via Prisma** (`connection_limit=1`) · SPA
vanilla sans framework ni build · déployé sur VM Oracle sous pm2.
Détail des services et de leurs contraintes non devinables : `CLAUDE.md`.

## Tâches

### En cours

- [ ] **Passe 3 de la recherche** — couche « phrase » : dates (« l'an dernier »),
      présence de pièce jointe, types de documents devenant des filtres visibles
      et retirables. Périmètre étroit, aucune « compréhension » simulée.
      *Plan validé avec l'utilisateur le 23/08 ; il a choisi les passes 1 et 2.*

### À traiter

*Constats mécaniques de l'audit d'usine du 03/09 (détail : `docs/JOURNAL.md`).*

- [ ] **`/api` plafonné à 60 requêtes/minute et par IP** (`RATE_LIMIT_MAX`, la
      valeur par défaut ET celle de production), pour ~6 requêtes par écran :
      dix écrans enchaînés rendent des 429 (mesuré le 03/09 — c'est ce qui a mis
      le tour des écrans au rouge). Un humain à un écran toutes les six secondes
      est dans la même zone. Le même limiteur couvre `/mcp` : **hypothèse à
      mesurer une fois**, pas une conclusion — les lots des tâches planifiées
      meurent vers 60, ce qui est aussi le plafond.
- [ ] **L'audit de socle ne franchit pas l'écran de connexion** : il n'atteint
      qu'une route publique. Contourné pour les écrans quotidiens par
      `.factory/scenarios/tour-des-ecrans.json` (qui se connecte, lui), mais
      l'audit §6/§7 lui-même ne juge toujours que la page publique.
- [ ] **3 écarts de socle sur l'écran de connexion** : champ mot de passe sans
      `<label>`, bouton « Se connecter » à 31 px (44 attendus) et police 13 px
      (14 minimum) sur mobile.
- [ ] **Cadrage abandonné depuis le 18/08** : dernier `.chantier/` à cette date,
      une centaine de commits depuis sans artefact de changement. (Le barrage de
      preuve, lui, tient : 18 décisions, 0 skip sur 30 jours.)
- [ ] **Un scénario de mutation n'est pas rejouable** : `decision-compteur-`
      `coherent` échoue faute de données et faute d'étape de restauration —
      limite de la DSL, déjà notée le 01/09.
- [ ] **Écart accentué résiduel** : le corps des mails n'est pas déplié.
      Mesuré : l'étendre coûterait +71 % de base et doublerait la recherche.
      `npm run banc:search` **sur le serveur** chiffrera l'écart réel — à
      trancher avec l'utilisateur.
- [ ] **Extraits des mails ENVOYÉS** (6 246, aucun) — verrou pour la détection
      automatique des affaires.
- [ ] Vue documentaire (Factures · Banque · Fiscal · Immobilier · Contrats).
- [ ] Lot 6 : retrait des colonnes plates et de la projection de compatibilité.
- [ ] Boîtes à enrôler : jojo56, techni-soft ×2, **location-miron**.
- [ ] `CLAUDE.md` à **14,86 Ko** (mesuré le 03/09) pour une limite auto-imposée
      de ~12 Ko — et 49 commits en 30 jours dessus : l'historique y remonte.

### Terminées

- [x] **Le front sous vérification** (03/09) — `tsconfig.web.json` (`checkJs`,
      `noEmit` : le JS reste du JS vanilla servi tel quel), `npm run typecheck`
      couvre désormais `src/` ET `web/`, donc le contrat de l'usine aussi.
      Deux vrais bugs au premier jour : **`api.health` déclaré deux fois** (la
      sonde publique était du code mort ; l'attente de redémarrage interrogeait
      une route qui rend 401 sans session) et **`draft.value` sur un div
      contenteditable** (Échap ne fermait pas la modale de réponse, et la garde
      « brouillon perdu » n'a jamais tourné). Découverte de fond : **`$` rendait
      `any`** — ses ~340 usages n'étaient contrôlés par rien. Ramené de 394 à 0
      par une passe mécanique (123 `querySelectorAll` → `$$`, 66 `e.target` /
      `e.currentTarget` → `elCible` / `elCourant`) et une trentaine
      d'annotations. Barrage prouvé par faute témoin.
- [x] **`npm run seed:dev`** (03/09) — deux boîtes synthétiques, douze mails.
      Sans données, un scénario passait au vert sans exercer une ligne de liste.
- [x] **`.factory/scenarios/tour-des-ecrans.json`** (03/09) — le premier
      scénario qui SE CONNECTE : six écrans quotidiens, 0 erreur console,
      pas de débordement. Lecture seule, rejouable.

- [x] **Recherche par MOTS** (23/08) — la phrase entière était cherchée comme un
      seul motif `LIKE` : « facture électricité miron » = une chaîne de 25
      caractères, donc écran vide. Valait pour toute recherche de plus d'un mot.
      Découpage en mots, mots creux écartés mais courts protégés (`RH`, `TV`,
      `RIB`, `T2`), `analysisInput` enfin cherché, repli qui NOMME le mot
      introuvable, concentration au score. **Banc local : 12/12 cas.**
- [x] **Accents ignorés** (23/08) — sujet, expéditeur, noms de pièces, résumé,
      entités. Colonnes tenues par déclencheurs SQLite, SQL engendré depuis la
      liste d'accents. **+6 % de base, +15 % de temps** (mesuré sur 41 000).
- [x] **`npm run banc:search`** (23/08) — rejoue des recherches et rapproche les
      paires accentuées ; signale les écarts au lieu de les cacher.
- [x] `main` avancée en fast-forward sur la branche de travail (259 commits),
      PR #1 fermée (son contenu y était intégralement).

## Décisions

| Date | Décision | Contexte | Alternatives rejetées |
|------|----------|----------|----------------------|
| 03/09 | Vérifier le front avec TypeScript **en lecture seule** (`checkJs`, `noEmit`), sans rien compiler | Le JS vanilla servi tel quel est un choix du projet ; le contrôle ne doit pas le remettre en cause pour être utile | Migrer `web/` en TypeScript (change la livraison) ; ESLint seul (n'aurait vu ni le `draft.value` ni le doublon `health`) ; ne rien faire (30 % des commits sans filet) |
| 03/09 | Tolérer le type **uniquement dans les helpers** (`$`, `$$`, `elCible`, `elCourant`) ; laisser `querySelector` écrit en toutes lettres rendre un `Element` strict | La sévérité sur `Element` est précisément ce qui a montré que `draft.value` était `undefined` sur un div contenteditable. L'élargir partout aurait effacé le seul vrai bug d'écran trouvé | Élargir `ParentNode.querySelector` par fusion d'interface (efface le bug) ; annoter les ~340 appels un par un (churn massif sur le fichier le plus disputé) |
| 03/09 | Borner le tour des écrans à six routes | `/api` plafonne à 60 requêtes/minute et un écran en coûte ~6 : au-delà, le scénario échoue sur des 429 qui ne disent rien du produit | Rallonger le tour (rouge trompeur) ; relever la limite pour le test (le scénario ne mesurerait plus la réalité) |
| 23/08 | Déplier les accents **à l'écriture**, dans des colonnes tenues par des déclencheurs SQLite | Plus de dix fichiers écrivent ces textes : un branchement TypeScript en oublierait un et la colonne mentirait en silence | Déplier à chaque requête (**mesuré 25× plus lent**) ; brancher chaque écriture en TS |
| 23/08 | Ne PAS déplier le corps des mails | Les noms accentués qui servent à retrouver vivent dans les sujets et les entités | Recopier le corps (**+71 % de base, recherche doublée**) ; borner à 3 000 car. (n'a presque rien rendu : la plupart des mails tiennent déjà sous cette taille) |
| 23/08 | Garder la recherche par **sous-chaîne** | « RIB » doit continuer de trouver « Ribéroux » — l'utilisateur dirait « avant ça marchait » | **FTS5** (change la sémantique, exige un index reconstruit) — écarté aussi par Codex |
| 23/08 | Engendrer le SQL des déclencheurs depuis la liste d'accents | Écrit à la main, il divergerait de celle qui déplie la requête — et une divergence là ne casse rien bruyamment, elle fait manquer des mails | Écrire les ~50 `replace()` à la main, quatre fois |
| 23/08 | Montrer à l'écran les mots compris et le repli | Découper en silence est pire que ne pas découper : l'utilisateur ne peut pas voir qu'un mot a été écarté | Découpage transparent mais muet |

## À retenir

- **Mesurer avant de concevoir.** Deux conceptions sur trois ont été écartées
  par le chronomètre le 23/08, dont celle que j'avais choisie au départ.
  Un corpus synthétique aux **dimensions réelles** (41 000 mails, corps de
  2 200 caractères, OCR sur 20 %) suffit à trancher.
- **Un banc doit signaler ce qui ne marche pas encore**, pas seulement valider.
  `banc:search` affiche l'écart accentué résiduel au lieu de le taire.
- Ce poste n'est **pas** celui décrit dans `CLAUDE.md` : ni le raccourci
  `ssh boxmail`, ni le pilote ChatGPT n'y existent (chemins sous un autre profil
  Windows). Le MCP Codex remplace le second.

## Changelog

- 2026-09-03 (3) : **le front passe au vérificateur.** Deux vrais bugs sortis le
  premier jour (doublon `api.health`, `draft.value` sur un contenteditable), et
  une découverte plus large : `$` rendait `any`, donc ses ~340 usages étaient
  hors contrôle **en le paraissant**. Leçons : un remplacement de masse veut une
  frontière d'identifiant (`e.target` avait mangé `p.ruleTargetFolder`) et une
  vérification des noms déjà pris ; `node --check` et le vérificateur attrapent
  des fautes DIFFÉRENTES, garder les deux. Décision de fond : **ne pas élargir
  le `querySelector` écrit en toutes lettres** — c'est sa sévérité qui a révélé
  le seul bug d'écran de la journée.

- 2026-09-03 (2) : **l'usine passée sur Boxmail pour de vrai.** `playwright-core`
  n'était résolvable nulle part sur ce poste → `observe`/`audit`/`verify` en
  `Cannot find module`, et donc la règle « capture obligatoire avant de livrer un
  écran » inapplicable sur une machine neuve. Ajouté en `devDependencies`.
  Mesures obtenues : typecheck vert, socle 3 écarts sur 9 règles (login),
  scénarios 1 vert / 1 rouge (mutation non rejouable), barrage de preuve 18/18.
  Leçon : **un contrat d'usine peut rendre vert en ne regardant pas le fichier le
  plus modifié** — ici les 12 303 lignes de `web/js/app.js`. Deux pièges de poste
  à remonter au plugin : `require('playwright-core')` résolu depuis le dossier du
  plugin (passer `NODE_PATH`), et `--route /x` mangé par la conversion de chemins
  de Git Bash (`/admin` → `C:/Program Files/Git/admin`).

- 2026-09-03 : audit de l'usine mené depuis ce projet → usine 1.8.2 (trois faux positifs
  corrigés : EIP sur `cat`/`sed`, garde sur le message de commit, drapeau de preuve consommé
  au succès du commit). Aucun code Boxmail modifié. Branche remise au niveau de `main`
  (12 commits de l'autre poste, dont `.factory.json` et le contrat `run`). Leçon : un clone
  local en retard m'a fait conclure à tort à l'absence de `.factory.json` — `git fetch`
  avant tout constat d'absence.

- 2026-08-23 : Recherche par mots + accents ignorés + banc de recherche ;
  `main` synchronisée ; index OpenSpec renseigné (pointe vers la doc existante).
