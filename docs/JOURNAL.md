# Journal des sessions — Boxmail / Mail Assistant

> Historique détaillé des livraisons et décisions, déplacé depuis CLAUDE.md le
> 01/08/2026 (le fichier faisait 84 Ko et était injecté dans chaque requête
> Claude, ce qui faisait planter les sessions — voir CLAUDE.md § Conventions).
> Ordre : du plus récent au plus ancien. Ajouter les nouveaux comptes rendus EN TÊTE.

## État (session en cours)

**TOUR 3 D'ANALYSE + 4 RÈGLES CONVERGENTES CODÉES (30/07).** 1 809 mails jugés,
221 expéditeurs corrigés, 0 rejet. **Quatre boîtes bouclées** (Altoen, Brimmo,
Au-marais, Location_Brest — 0 douteux) ; Colocar 4, Econom 3 ; thony56_gtr
8 982 restants (13 % de couverture, mais lecture des extraits à 100 %).

**MÉTHODE : ne coder qu'une règle qui CONVERGE sur plusieurs boîtes.** Les
agents en ont proposé 23 ; 4 retenues. Une règle vraie sur une seule boîte est
une coïncidence.

1. **LE PLUS GROS TROU DU MOTEUR ÉTAIT LA PUBLICITÉ.** Sur Location_Brest,
   165 mails sur 323 (51 %) étaient de la pub classée `info` — donc invisible
   pour `promo30`. Les sujets réels n'emploient JAMAIS le mot « promo » :
   « ⏳ 72H Flash », « on vide les caisses », « 💸On baisse le prix »,
   « 17 500 € d'économie », « vos 10€ vous attendent ». Motifs élargis, et
   surtout la pub est désormais cherchée **dans l'extrait** — seul motif faible
   admis là, sous DEUX conditions : enveloppe marketing (`hasListUnsubscribe`,
   ce qui la distingue d'un contrat mentionnant « -20 % ») et aucun marqueur
   d'obligation. Mesure : +147 mails reconnus.
2. **VETO D'OBLIGATION** (`OBLIGATION_RE`) : `bonjour@comptastar.fr` envoie le
   parrainage ET « [ACTION REQUISE] – Mise en conformité », dont l'enjeu est la
   dissolution. Sans ce veto la règle 1 aurait balayé le second avec le premier.
3. **BOÎTE DE FONCTION ⇒ `company`, jamais `person`** (`compta@`, `agence-…@`,
   `recouvrement@`, `sav@`, `tcs@`). ~20 expéditeurs Brimmo étaient `person` —
   la catégorie la plus protégée — donc soustraits au nettoyage ET à l'analyse.
   Périmètre étroit EXPRÈS : ni `contact@`, ni `info@`, ni `service@` (adresses
   ordinaires des artisans, testées en contre-cas) ; aucune tentative de
   reconnaître les boîtes nommées d'après une ville — rien ne les distingue
   mécaniquement d'un surnom.
4. **DEUX MOTIFS PROTECTEURS** : « appel de fonds » était classé RENDEZ-VOUS à
   cause de la date (ni facture ni protection) ; les avis de versement (« Un
   versement de 1 629,58 € a été envoyé ») deviennent `document`, le montant en
   € étant exigé pour ne pas attraper « 500 GuestPoints offerts ».

**DÉFAUT DE CAPTURE CORRIGÉ** : sans partie `text/plain`, l'extrait stocké était
du balisage brut — les heuristiques le lisaient COMME DU TEXTE (elles pouvaient
s'accrocher à n'importe quel mot du HTML) et l'IA le jugeait inexploitable, donc
~110 mails de la boîte perso restaient protégés à vie. `cleanSnippet` dégage
maintenant le texte (détagage sans dépendance + décodage des entités : le
courrier français en est truffé, sans quoi « n&deg;2281 » devenait « n 2281 »).

**LA SIMULATION A ENCORE SAUVÉ LA MISE — 2e fois de la série.** Passage à blanc
sur les 21 167 mails réels AVANT d'appliquer : (a) « cadeau » attrapait « Re:
cadeau pour noah », un mail de famille ; (b) « à saisir » attrapait « Pensez à
saisir vos réponses » (saisir = renseigner) ; (c) ma règle de boîte de fonction
passait DEVANT la détection de newsletter, si bien que
`service.client@mails.totalenergies.fr` sortait de `newsletter90` — la règle
devait empêcher `person`, pas rendre un expéditeur MOINS nettoyable. Les trois
sont devenus des contre-cas du test (43 assertions).
**RÈGLE DE TRAVAIL : toujours simuler sur les données réelles avant d'appliquer
une règle de classement. Un test unitaire ne peut pas voir ces cas.**

**MÊME BUTÉE QU'AVANT, CONFIRMÉE** : +147 promos reconnues → +45 récupérables
seulement, parce que `promo30` exige `unseenOnly`. La classification n'est plus
le goulot, **les stratégies le sont**. D'où le preset **`promo365`** (« plus d'un
an, même déjà ouvertes », désactivé) : **1 979 visés, 105 protégés**.
Récupérable : 8 542 → **8 762 mails / 1,3 Go**.

**`npm run audit` LIVRÉ + 20 DÉFAUTS CORRIGÉS (30/07).** Déclencheur : « ce que
tu as découvert là doit se produire partout ailleurs » — chaque défaut trouvé
jusque-là avait demandé une capture d'écran de l'utilisateur.

**L'OUTIL** (`src/cli/audit.ts`, 6 familles A→G). Ce qui a de la valeur est la
partie DYNAMIQUE : on exécute les vrais services sur la vraie base, on capture
le SQL réellement émis (événements Prisma, activés par `BOXMAIL_SQL_TRACE=1`
pour ne rien coûter en prod) et on le passe à `EXPLAIN QUERY PLAN`. Les règles
statiques sont des regex sur 7 000 lignes de JS : marquées « à vérifier »,
JAMAIS « confirmé ». Persistance : `docs/audit-findings.json`, clé STABLE
`famille:fichier:fonction:règle` (jamais le n° de ligne) ; le script rafraîchit
tout ce qui est CALCULÉ (gravité, titre, mesure) et ne touche jamais aux trois
champs DÉCIDÉS (`status`, `note`, `firstSeen`). `docs/AUDIT.md` est régénéré.
⚠️ Sur le serveur : **`npm run audit -- --out logs`** — écrire dans `docs/`
salirait l'arbre Git et ferait échouer le `git merge --ff-only` de la mise à
jour. Les statuts sont toujours lus dans `docs/` (versionné).

**QUATRE DÉFAUTS DE L'OUTIL, tous trouvés en l'exécutant** — à relire avant
d'ajouter une règle : (1) la regex `class="…"` avalait les gabarits
`${x ? 'a' : 'b'}` → 103 faux positifs ; (2) beaucoup de classes n'ont
VOLONTAIREMENT aucun style, ce sont des crochets `querySelector` → 44 faux
positifs ; ne reste signalée que la classe ni stylée NI interrogée (c'est ainsi
qu'on trouve `.tablewrap`) ; (3) **`EXPLAIN QUERY PLAN` désigne les tables par
leur ALIAS** (« SCAN f », « SCAN main.AttentionState ») : la 1re version
extrayait « f » et « main », ne les trouvait pas, et les écartait EN SILENCE —
un « SCAN m » sur 34 877 lignes serait passé inaperçu, le faux feu vert qu'un
audit ne doit jamais donner ; (4) un passage `--static` faisait passer tous les
constats mesurés pour « disparus ». Et `nowrap` SEUL ne tronque pas : il faut
`ellipsis`, ou `nowrap` AVEC `overflow:hidden`.

**LE DÉFAUT CENTRAL CORRIGÉ : `openCleanupModal`**, jumeau exact du bug du
29/07 mais sur l'écran qui SUPPRIME. Quatre défauts imbriqués : le sujet était
dans un `<label>` englobant (cliquer COCHAIT la case), son `title` portait les
signaux et non le sujet (donc le sujet tronqué était irrécupérable), modale de
560 px, pas de `under-reader`. Cause racine côté API : `CleanupMessage` n'avait
ni `account` ni `folder` alors que la route connaissait le dossier. Corrigé
aux deux niveaux ; 14 vérifications navigateur dont le contre-cas « cliquer le
sujet ne bouge pas la case » et « lecteur z 96 au-dessus de l'overlay z 94 ».

**UNE CORRECTION DE MON PROPRE AUDIT** : j'avais classé « critique » le
`sampleSubjects: string[]` de `previewSenderCleanup` en le prenant pour
l'échantillon affiché avant suppression. Il n'était affiché NULLE PART — code
mort, supprimé. Vérifier qu'un constat atteint l'écran avant de le juger grave.

**AUTRES CORRECTIFS** : `openNoiseModal` (date en dernière colonne + expéditeur
`nowrap` sans plafond = le mécanisme d'hier), `openRulePreview` + `rules.ts`
(coordonnées jointes, sujets ouvrables), `renderToday` (date de réception et
ouverture au clic posées dans `todayRow`, donc les 4 listes d'un coup ; pour une
échéance c'est `msgDate`, la date du MAIL), `.tablewrap` (classe morte → règle
ajoutée), index `Deadline(messageId,status)` / `AnalysisFeedback(messageId)` /
`AttentionState(messageId)`, **`PRAGMA optimize`** au démarrage (l'`ANALYZE`
d'une migration ne joue qu'UNE fois — il fournissait la moitié du gain
40 s → 178 ms, et les statistiques auraient péri sans signal).

**OCTETS NULS dans `retention.ts` et `categorize.ts`** : ils étaient
INTENTIONNELS (séparateur de clé composite `` `${a}\0${b}` ``, bon choix) mais
ripgrep classait les fichiers « binaires » et les SAUTAIT en silence. Remplacés
par l'échappement ` ` — chaîne identique à l'exécution, source lisible.

**BILAN : 70 constats, 22 clos (20 corrigés + 2 faux positifs assumés),
48 ouverts — aucun critique, aucun grave.** Restent (dans `docs/AUDIT.md`,
`status: todo`) : les culs-de-sac analytiques (`report`/`learning`/
`unsubscribe` n'exposent aucun mail cliquable), `tasks.ts` sans `msgDate`,
`learning.ts` qui conserve l'auto-jointure par ligne que `Sender.engagedAt` a
éliminée ailleurs, les N+1 en écriture (`rebuildSenders` 3 677 upserts,
`linkThreads`, `unsubscribe` ×1000), `ORDER BY RANDOM()` ×10 dans `quality.ts`,
et 7 balayages de table mesurés — tous sous 700 ms aujourd'hui, donc classés
faible avec leur chrono : **un audit qui crie au loup ne sert à rien.**

**C3c LIVRÉ + LA PAGE DE NETTOYAGE PASSE DE 40 s À 0,2 s (29/07).** Trois
choses, toutes déclenchées par une mesure ou une capture de l'utilisateur.
1. **Stratégie « verdict IA »** (preset `ai_archive90`, désactivé comme les
   autres) : `RetentionPolicy.matchAiAction`. RAISON CHIFFRÉE — 3 263 mails
   jugés « à archiver » par l'IA dont **2 026 DÉJÀ LUS**, or `promo30` et
   `newsletter90` exigent `unseenOnly` : ces mails étaient hors d'atteinte de
   TOUTE stratégie alors qu'ils avaient été lus un par un. L'analyse n'était
   plus le goulot, les stratégies l'étaient. Exige `analysisConfidence='high'`
   (la protection centrale n'écarte que `low` — sans ce test un « peut-être »
   entrerait dans une purge). Vise 2 447 mails, 203 protégés.
2. **PERF, en deux temps, chaque fois en MESURANT au lieu de supposer.**
   (a) `engagedSenderClauses` rejouait PAR LIGNE et par requête un auto-join de
   Message sur threadId filtré par (compte, expéditeur) — 364×364 opérations
   pour Leroy Merlin seul, ×14 requêtes. Pré-calculé dans `Sender.engagedAt`
   par `computeSenderEngagement` (appelé depuis `rebuildSenders`) → 40 s →
   12,9 s. Sémantique identique, y compris « date inconnue = engagement
   d'aujourd'hui ». (b) Restait 12,9 s : chronométrage PAR STRATÉGIE →
   `newsletter90` 7,5 s, `social90` 2 s, les autres < 400 ms ; point commun =
   `Sender.category`, indexé nulle part. Index + **ANALYZE** (que SQLite ne
   lance jamais seul — sans statistiques son planificateur ignore les index)
   → **178 ms**. Vérifié en prod : listPolicies 235 ms, deletableUnion 141 ms.
   LEÇON : j'ai d'abord optimisé les clauses de protection ; elles ne
   coûtaient que 179 ms. Chronométrer avant de coder.
   ⚠️ `Sender.engagedAt` DOIT être backfillé après déploiement, sinon la
   protection graduée disparaît (fait : 1 155 / 3 676 expéditeurs engagés).
3. **Aperçu de stratégie lisible** (« pas de possibilité de lire le détail en
   cas de doute, pas de date de la réception, mail de 2020 pas traité pareil
   que 07/2026 »). La date ÉTAIT renvoyée par l'API — la table débordait du
   cadre et la colonne se retrouvait coupée à droite. `modal-wide`, colonne
   « Reçu le » remontée en 2e position, sujets ouvrables via `under-reader`
   (le lecteur s'ouvre AU-DESSUS de l'aperçu).
Récupérable : 7 050 → **8 225**. Test : 16 asserts (contre-cas compris :
confiance moyenne écartée, verdict « à lire » écarté, trop récent écarté,
protection graduée vérifiée dans les deux sens).

**C4 LIVRÉ (29/07) : les trois règles tirées de la passe, codées dans le
moteur.** Choix assumé : les règles vont dans `categorizeSender`, PAS dans un
écran de suggestions — c'est là qu'elles servent aux ~31 000 mails que l'IA
ne jugera jamais. Chaque règle est adossée à une requête en base, et la
CAUSE réelle différait de ce que la première passe laissait croire :
1. **Le raccourci « conversation » fabriquait les fausses personnes**
   (860 des 1 084 « personne » automatiques portaient la raison « vous avez
   déjà échangé »). Un accusé de non-remise EST une réponse à ton envoi : le
   fil contient un sortant ⇒ « conversation » ⇒ « personne », la catégorie la
   PLUS protégée. Et le test d'adresse automatique passait APRÈS, donc n'était
   jamais atteint. Ce n'était PAS le nom affiché, contrairement à ce que
   j'avais écrit d'abord. Correctif : garde-fou `isServiceAddress` DEVANT le
   test de conversation. Volontairement restreint : ni `info@`, ni `contact@`,
   ni `service@` (adresses ordinaires des artisans réels — testé).
2. **Caisses bancaires régionales invisibles** : elles écrivent depuis
   `ca-<region>.fr` sans jamais nommer « crédit agricole ». Ajout de
   `ca-*.fr`, `e-ca-*.fr`, `cmb.fr`, monabanq/oney/cofidis/bpp…
3. **Marque protégée refusée depuis une boîte GRATUITE.** PIÈGE ÉVITÉ DE
   JUSTESSE : ma première version n'acceptait la marque que dans l'adresse —
   la simulation sur les 2 996 expéditeurs réels a montré qu'elle déclassait
   23 organismes AUTHENTIQUES passant par un prestataire (`no-reply@xoom.com`
   pour PayPal, `bnpp-epargne-entreprise@s2e-net.com`, une agence AXA).
   Le bon critère était ailleurs : `team_execsales@accountant.com` est un
   webmail gratuit (famille mail.com) — une banque n'écrit jamais de là.
   **TOUJOURS simuler sur les données réelles avant de déployer une règle de
   classement** : le test unitaire seul n'aurait pas vu la régression.
Ajout des réseaux 2000 (hi5, Meetic, Badoo, Skyrock, Copains d'avant, WAYN,
Facebox, Viadeo, MySpace). Test : 37 asserts bâtis sur des expéditeurs
RELEVÉS EN BASE, contre-cas compris. Backfill lancé sur les 7 boîtes.
MESURE : récupérable 6 746 → **6 925** (+179), fausses « personnes » auto
1 084 → 1 013 (−71). Le gain en volume est modeste ; le vrai gain est la
sûreté (les documents bancaires ne sont plus du bruit).

**PREMIER RATTRAPAGE MASSIF EXÉCUTÉ (29/07) : 3 389 mails jugés, 677
expéditeurs corrigés.** Demande utilisateur : « répare les extraits et lance
ici par blocs de 500 les analyses de mails. Tu peux le donner à un agent
dédié. » Méthode : **un agent par boîte** (les scopes doivent être DISJOINTS
— `next_analysis_batch` n'a AUCUN mécanisme de réservation, deux agents sur
la même boîte recevraient les mêmes mails), 5 lots de 100 chacun, via la
recette PowerShell MCP (initialize → capturer `mcp-session-id` → tools/call ;
réponses en SSE, JSON dans `.result.content[0].text`). Résultat : 3 389
appliqués, **0 rejet**, Econom entièrement bouclée. Confiance faible :
4 071 → 3 405. Récupérable mesuré APRÈS : 6 746 (je n'avais pas pris la
mesure AVANT — à faire au prochain tour, c'est LA métrique de C5).
Actions proposées : archive 2 023 / read 1 162 / reply 74 / pay 44.

**CE QUE L'ANALYSE DE CONTENU A RÉVÉLÉ — matière brute pour C4.** Un motif
domine, confirmé sur les 7 boîtes : **les robots dont le nom affiché est un
nom humain étaient classés `person`**, donc protégés à vie par la garantie
« 0 mail personnel » et INNETTOYABLES. Exemples réels : `Yao Eve
<member@hi5.com>`, `Morgane Mahe <first_reminder@whereareyounow.net>`,
« Florian de Meilleurtaux », « Marc De Diego Ferrer » (MCA Andorra, ~30
mails), « Alerte PERCHE David » (agences immo), et `postmaster@outlook.com`
DANS CHAQUE BOÎTE. Règle à coder : nom affiché humain + adresse de service
(no-reply/member/notification/first_reminder/alerte) ⇒ jamais `person`.
Deux erreurs symétriques, plus graves que le bruit : **un faux PayPal
(`team_execsales@accountant.com`) était classé `bank` en confiance haute** —
l'hameçonnage héritait de la protection bancaire ; et **le Crédit Agricole
Morbihan était classé `newsletter`** sur Econom — ~60 mails de documents
bancaires traités comme du bruit, dont un « Avis Tiers Détenteur » (saisie
sur compte). Les heuristiques se trompaient dans les DEUX sens sur ce qui
compte le plus. Erreur inverse aussi : « Mes primes Travaux » classé
`social` alors que c'est un interlocuteur réel (primes CEE, 1 943 €).

**GARDE-FOU « DATABASE IS LOCKED » : JAMAIS INSTALLÉ (trouvé et corrigé).**
Découvert en lançant une mesure : chaque démarrage loggait « SQLite : PRAGMA
non appliqués — Execute returned results, which is not allowed in SQLite »,
jamais lu. CAUSE : `PRAGMA busy_timeout = 5000` RENVOIE une ligne, ce que
Prisma refuse sur `$executeRawUnsafe` ; les trois PRAGMA partageant un seul
`try`, l'exception emportait les deux derniers. En production : WAL était
bien posé (premier, et via `$queryRawUnsafe`), mais **busy_timeout restait à
0 et synchronous au défaut** — la protection P0.1, celle-là même dont
l'absence avait fait échouer une mise à jour, n'existait pas. Correctif :
tout par `$queryRawUnsafe`, un `try` PAR pragma, et RELECTURE des valeurs
journalisée (sans relecture une perte reste invisible — c'est exactement ce
qui s'est produit). Vérifié en production : `wal / 5000 / 1`, zéro
avertissement. Test : 4 asserts ; busy_timeout et synchronous étant des
réglages PAR CONNEXION, les voir posés prouve que c'est le code qui les met.

**Sur le contenu des boîtes (à ne plus redécouvrir).** `Colocar` n'est PAS
de la colocation immobilière malgré son nom : c'est la SASU de location et
négoce de VÉHICULES (salles des ventes, cartes grises, Getaround).
`Au-marais` est une location saisonnière parisienne (Airbnb puis
HomeExchange, Smoobu, Stripe). `Brimmo` tourne quasi entièrement autour du
rachat/réhabilitation du 46 rue de la République à Brest. `thony56_gtr` : le
plus ancien fond est de 2006-2008 (eBay, Assedic, réseaux sociaux morts).

**RESTE À FAIRE.** thony56_gtr = 10 115 douteux (4 % fait) — à ce rythme 20
tours ; c'est l'argument pour C3b (Haiku serveur, ~4,70 $ le reliquat,
~2,35 $ en Batch API — clé API Anthropic requise, PAS ENCORE DEMANDÉE à
l'utilisateur). Autres restes : Brimmo 1 126, Au-marais 859,
Location_Brest 822, Altoen 294, Colocar 184. La lecture des extraits n'est
pas finie sur thony56_gtr (15 333 / 20 220) : le nombre de douteux MONTERA
encore à mesure qu'elle avance. Puis C4 (coder les règles ci-dessus) et C5.

**C2 + C3a LIVRÉS (29/07) : l'IA peut enfin juger, et son verdict DÉBLOQUE le
nettoyage.** Migration `ai_verdict` (Message.aiSummary/aiAction/aiVerdictAt/
aiModel/intentSource). `services/analysis.ts` : `nextAnalysisBatch` (lot
compact — c'est le forfait qui paie ces jetons), `applyVerdicts` (CHEMIN
D'ÉCRITURE UNIQUE des deux moteurs), `analysisProgress`. 2 tools MCP
(`next_analysis_batch`, `submit_analysis_batch`) : la session Claude boucle
jusqu'à `remaining=0`. LE CHOIX QUI FAIT TOUT : l'IA écrit dans les champs
EXISTANTS avec `source='ai'` → aucun moteur à modifier. TROIS PROTECTIONS
indispensables, sans lesquelles la sync suivante effacerait le rattrapage :
`categorizeAccount` saute `intentSource='ai'`, `computeConfidenceForAccount`
saute `aiVerdictAt != null`, `rebuildSenders` traite `categorySource='ai'`
comme `'manual'`. L'IA ne remplit la catégorie d'un expéditeur que si elle vaut
`company`/vide ET si le verdict est sûr (sinon elle changerait au gré des
mails). Tests : 35 asserts, dont la preuve de bout en bout — `deletableUnion()`
passe de 0 à 1 quand le verdict remonte la confiance, et retombe à 0 si on la
rebaisse. **PRÉ-REQUIS UTILISATEUR pour le rattrapage : brancher le connecteur
MCP** (`https://boxmail.lb2i.com/mcp` + bearer) sur une session Claude, puis
demander « analyse mes mails ». RESTE : C3b (Haiku serveur, flux courant),
C4 (règles découvertes), C5 (mesure du gain).

## Accès au serveur de production (à ne plus rechercher)

- VM Oracle : `ubuntu@51.170.60.55` (hôte `instance-20260728-1911`), dépôt
  dans **`/home/ubuntu/boxmail`**, app sous pm2 (`boxmail-mcp`).
- Clé privée rangée sur le PC de l'utilisateur :
  `C:\Users\leberan\.ssh\oracle-boxmail.key` (droits restreints à son compte),
  avec un raccourci dans `~/.ssh/config` : **`ssh boxmail`** suffit.
- **PIÈGE (perdu ~1 h le 29/07)** : l'« Oracle Cloud Shell » de la console
  N'EST PAS la VM — c'est une machine de console séparée, avec son propre
  clone du dépôt dans `~/boxmail`. Une commande lancée là-bas met à jour ce
  clone et ne touche PAS la production ; le symptôme est
  `bash: pm2: command not found`. Toujours vérifier l'invite : `cloudshell`
  = mauvaise machine.
- Mise à jour désormais gérée par un **minuteur systemd**
  (`boxmail-update.timer`, chaque nuit 04:00 UTC) qui exécute
  `deploy/update-boot.sh` → `deploy/update.sh`. `AUTO_UPDATE_HOUR=-1` dans le
  `.env` du serveur : la mise à jour interne à l'app est éteinte, il n'y a
  qu'UN responsable.
- Vérification rapide qu'un déploiement a pris : `GET /api/analysis/coverage`
  répond **401** (route existante, session requise) et non 404.
- Ne JAMAIS déposer de clé dans le dossier du projet : `git add -A` la
  publierait. `.gitignore` couvre désormais `*.key`, `*.pem`, `id_rsa*`.

## État (fin de session précédente)

**LA MISE À JOUR DEPUIS L'INTERFACE NE POUVAIT PAS FONCTIONNER SOUS LINUX
(29/07) — corrigé.** Symptôme : serveur bloqué sur `01fbb4e` (23h03), 5
commits de retard, avec « ⚠️ dernier passage 06:00 : échec — npm run build
a échoué (code 2) : error TS2688 ». CAUSE, reproduite en local : pm2 lance
l'app avec `NODE_ENV=production` (ecosystem.config.cjs), donc tout
`npm install` lancé PAR l'app hérite de cet environnement et npm écarte les
devDependencies — `@types/node` disparaît (`typescript` survit, d'où un tsc
qui démarre puis meurt sur `TS2688: Cannot find type definition file for
'node'`, à cause de `"types": ["node"]` dans tsconfig). Le déploiement
initial passait, lui, par SSH — shell normal, devDependencies installées :
**le bouton de mise à jour n'avait donc jamais réussi sous Linux**.
CORRECTIF : `npm install --include=dev` dans update.ts ET autoupdate.ts
(vérifié : sans le flag `@types/node` disparaît et le build meurt ; avec, il
passe, à `NODE_ENV=production` inchangé). DEUX DÉFAUTS RÉVÉLÉS AU PASSAGE,
corrigés aussi : (1) `cachedVersion` n'était vidé qu'en fin de mise à jour
réussie — après un échec, l'interface affichait l'ANCIEN commit tout en
annonçant « ✅ à jour » (le dépôt, lui, était en avance après le pull) ;
c'est ce qui rendait la panne illisible. Le cache est maintenant vidé juste
après le pull. (2) `applyUpdate` (bouton) n'avait AUCUN retour arrière,
contrairement à `runAutoUpdate` — un échec laissait le dépôt en avance sur
le binaire en service. Retour arrière ajouté, symétrique.
**AMORÇAGE** : le correctif ne peut pas s'appliquer tout seul (le code qui
tourne est l'ancien, il relancera l'ancienne commande) — une intervention
SSH unique était nécessaire, cf. la commande donnée à l'utilisateur.

**SÉRIE C LANCÉE — C0 + C1 LIVRÉS : l'assistant lit enfin le TEXTE des
mails (29/07).** Déclencheur : « je ne suis pas du tout satisfait du
résultat […] rajoute un peu d'IA, au moins sur les 3 derniers mois ».
DIAGNOSTIC (vérifié dans le code) : tout le classement tenait sur deux
signaux — des listes de marques en dur (`categorizeSender`, hors listes ⇒
`company`, la case « je ne sais pas ») et des regex **sur le sujet seul**
(`detectIntent`, sans motif ⇒ `info`). Engrenage : `computeConfidence`
traite `company` comme non-signal, donc inconnu + `info` ⇒ **confiance
faible**, et `protectionClauses` (retention.ts) exclut la confiance faible
de tout nettoyage. **Tout mail non reconnu était donc à la fois mal analysé
ET non nettoyable** — le moteur était muet là où il devait travailler.
RACINE : l'index ne stockait AUCUN texte. Livré : `Message.snippet` /
`snippetAt` (migration), `imapService.fetchSnippets` (un verrou, plage
`a:b`, download de la SEULE partie texte — **aucun repli sur le mail
complet**, il aspirerait la boîte sur un rattrapage), `services/snippets.ts`
(backfill reprenable via job « extraits », passe post-sync limite 150 sur
les plus RÉCENTS, `analysisCoverage` = la mesure « avant » de C0),
`detectIntent` accepte l'extrait — consulté en DERNIER recours et sur les
seuls motifs FORTS (les motifs faibles « confirmation / document / promo »
classeraient la moitié de la boîte de travers). PIÈGE TRAITÉ : après
correction d'une intention on recalcule la confiance EN ENTIER — jamais de
remise à `null` pour forcer un « onlyMissing », parce qu'une confiance
nulle n'est pas « faible » et ne déclenche donc PAS la protection (une
rétention auto lancée entre-temps viserait ces mails). Interface : panneau
« 🔎 Compréhension des mails » dans Paramètres (couverture + boutons
3 mois / toute la boîte) et extrait sous le sujet dans la liste
(`SearchResultItem.snippet`, tronqué à 160 car. côté API — le stockage en
garde 500 pour l'analyse). Tests : 38 asserts, dont « la pièce jointe n'est
JAMAIS téléchargée » (client IMAP stubbé), l'idempotence du rattrapage et
« aucun mail laissé sans confiance ». Le test a aussi rattrapé une donnée
de test irréaliste : le sujet « Bulletin du mois » déclenche la règle
`document` par le SUJET — on aurait cru à tort que l'extrait servait.
**À FAIRE PAR L'UTILISATEUR** : lancer « 📖 3 derniers mois » dans
⚙️ Paramètres (long : chaque mail est ouvert une fois), puis regarder si le
tri s'améliore. **SUITE : C2 + C3a** (verdict IA écrit dans les champs
EXISTANTS `intent`/`category`/`analysisConfidence` avec source `'ai'`,
précédence manual > ai > auto, + 2 tools MCP `next_analysis_batch` /
`submit_analysis_batch` pour le rattrapage massif sur le forfait) — plan
détaillé dans ROADMAP.md § « Série C ».

**P2.3 — PROTECTION PAR LA NATURE DU MAIL (29/07).** Retour utilisateur
avec capture : la fenêtre proposait 364 mails de `no_reply@leroymerlin.fr`
TOUS cochés, « Votre facture » et « Votre ticket 378 » compris — « tu
confonds des mails de publicité avec des mails contenant des pièces jointes
de tickets ». DÉFAUT STRUCTUREL : on classait par EXPÉDITEUR (unsubscribe /
noreply), or un magasin envoie ses pubs ET tes tickets depuis la MÊME
adresse robot — aucun signal expéditeur ne peut les séparer. Corrigé aux
3 niveaux : (1) categorize.ts, motif `document` élargi (ticket de caisse,
votre ticket, reçu, bon d'achat, garantie, duplicata, certificat) — sans ça
« Votre ticket 378 » = `info` ; (2) cleanup.ts : `documentSignals()` +
3e catégorie `kind='document'` PRIORITAIRE sur `auto` (pièce jointe /
intention invoice-document / sujet nommant une pièce), `keepCount` +
`deletableCount` par expéditeur (groupBy) → l'estimation « N sûrs » exclut
les pièces, `documentUidsOf()` retire les pièces quand on nettoie « tout
l'expéditeur » sans sélection ; (3) retention.ts `protectionClauses()` +=
`m.hasAttachments = 0` et `intent NOT IN ('invoice','document')` → vaut
pour TOUTES les stratégies, y compris auto. UI : case **📄 À conserver**
décochée par défaut + badge vert par ligne + « 📄 N gardés » dans les
3 tableaux. Tests : 19 asserts rejouant sa capture (9 pubs/OTP supprimables,
6 tickets/factures gardés) + aperçu réel de la stratégie « promotions ».
**L'UTILISATEUR DOIT RELANCER 🏷️ Recalculer les catégories** — l'existant
porte l'ancienne intention.

**Journal ouvrable + boîte visible sur le nettoyage (retours utilisateur
29/07).** (1) « dans activité récente, on déploie les mails concernés mais
ensuite on ne peut pas les afficher, on a juste l'en-tête » : les items du
journal ne portaient que sujet+date. `OperationEntry.items` accepte
maintenant `folder`/`uid` OPTIONNELS — renseignés UNIQUEMENT quand le mail
est resté en place (detect_deadlines, tâches créées/terminées, marquage
lu/non-lu) et volontairement OMIS après suppression/déplacement (l'UID ne
pointerait plus sur rien ⇒ pas de lien mort). `validateUids` (search.ts)
renvoie l'uid par item, l'appelant décide. Front : `opLine` rend le sujet
en lien `[data-op-open]` quand folder+uid sont là, écouteur DÉLÉGUÉ dans
installGlobalUx (les lignes sont réécrites à chaque rafraîchissement).
(2) « il manque un indicateur de couleur permettant de dire dans quelle
boîte le ménage va être effectué » : `accountChip` sur les lignes du
panneau « Nettoyage conseillé », dans le titre de la modale, dans la phrase
d'intro ET sur le bouton d'action (« vers la corbeille de <boîte> ») —
`accountChip(slug, {onDark:true})` (pastille opaque, sinon illisible sur le
bouton vert). Tests : ui-oplog-open.mjs, 14 checks (dont le contre-cas
« mail supprimé non cliquable » et l'ouverture réelle du corps).

**L6.1 — LE SERVEUR SE MET À JOUR TOUT SEUL (28/07).** Déclencheur :
« on ne va pas faire des déploiements manuels pour le futur… », après une
mise à jour SSH en échec sur `database is locked`. CAUSE : la mise à jour
lançait `npm run db:setup` (= `prisma migrate deploy`) PENDANT que l'app
tenait le fichier SQLite — le moteur de migration exige l'exclusivité. Même
piège que sous Windows, jamais traité côté Linux ; automatiser sans corriger
aurait cassé CHAQUE nuit. RÈGLE POSÉE : **on ne migre jamais pendant que
l'app sert**. `scripts/db-setup.mjs` accepte `generate`/`migrate`
(npm run db:generate / db:migrate) ; `src/db/migrate.ts`
(`ensureMigrationsApplied` : compare prisma/migrations à
`_prisma_migrations`, ne lance le moteur que s'il reste du travail, ferme la
connexion avant) appelé dans index.ts AVANT `app.listen` — échec ⇒ on
démarre quand même (pas de boucle pm2) ; update.ts et autoupdate.ts font
`db:generate` seulement ; setup-oracle.sh arrête l'app avant db:setup s'il
est relancé. `services/autoupdate.ts` : passage quotidien à
`AUTO_UPDATE_HOUR` (défaut **4**, activé par défaut EXPRÈS pour que le
serveur déjà installé sans la variable se mette à jour ; ignoré sous
Windows) — check → note le commit → sauvegarde → pull → install → generate
→ build → exit(0) (pm2 relance) ; **échec ⇒ `git reset --hard` sur le commit
d'avant + rebuild**, on reste sur la version d'hier qui marche. État dans
GET /api/version → ligne « Mise à jour automatique » des Paramètres. Tests :
12 asserts migrations + 14 asserts autoupdate sur un vrai dépôt git jetable
(dont le retour arrière vérifié fichiers à l'appui) + démarrage réel sur
base neuve (16 migrations en 2,6 s puis /health OK).

**L6 DÉPLOIEMENT FAIT (28/07) — le serveur tourne en ligne.**
`https://boxmail.lb2i.com` — Oracle Cloud ARM (VM.Standard.A1.Flex, 6 Go,
Ubuntu 24.04 Minimal aarch64), région Madrid, IP `51.170.60.55`. Vérifié de
l'extérieur : /health OK, certificat Let's Encrypt valide, redirection
http→https, /mcp sans token = 401, HSTS + nosniff actifs.
PIÈGES RENCONTRÉS (tous corrigés dans le dépôt) : (1) shape `E5.Flex`
choisie par erreur = PAYANTE (~30 $/mois) → seules `A1.Flex` (ARM) et
`E2.1.Micro` sont Always Free ; (2) capacité Always Free saturée → il faut
passer le compte en Pay As You Go (reste gratuit) ; (3) image Minimal sans
`git` ni `curl` → installés en tout premier ; (4) iptables d'OCI bloque
tout sauf SSH → ouverture 80/443 ajoutée au script ; (5)
`ecosystem.config.js` refusé par pm2 (projet en modules ES) → renommé en
`.cjs` ; (6) session SSH mobile qui se coupe → le script accepte
BOXMAIL_DOMAIN/BOXMAIL_EMAIL/BOXMAIL_ADMIN_PASSWORD pour une installation
en UNE commande, lançable via `nohup` en arrière-plan.
Reste côté utilisateur : enrôler les boîtes, brancher le connecteur Claude
(URL `https://boxmail.lb2i.com/mcp` + bearer du récap).

**Transfert des boîtes entre installations (demande utilisateur : « une
fois renseignée en local ou sur le site, besoin de le faire seulement une
fois »).** `services/portability.ts` : exportAccounts déchiffre les
cacheBlob avec la clé LOCALE puis rechiffre le tout avec une phrase secrète
(scrypt + AES-256-GCM, 12 car. min) → le fichier ne dépend d'aucune
machine ; importAccounts fait l'inverse et ne remplace une boîte déjà
enrôlée QUE sur accord explicite (overwrite). POST /accounts/export et
/accounts/import. Panneau « 📦 Transférer mes boîtes » dans Paramètres,
avec DEUX avertissements : le fichier donne un accès complet aux boîtes, et
après transfert il ne faut utiliser QU'UNE installation (les jetons de
rafraîchissement tournent — deux installations actives se déconnecteraient
mutuellement). Tests : 15 asserts (aucun jeton en clair dans le fichier,
mauvaise phrase refusée sans indice, fichier altéré détecté par GCM, et
surtout le cache MSAL restitué IDENTIQUE = accès réellement utilisables)
+ 9 checks navigateur.

**PHASE 2 « NETTOYER POUR DE VRAI » (P2.1 + P2.2, 28/07).**
- **P2.1 protection graduée** : `ENGAGEMENT_HORIZON_DAYS = 730` dans
  retention.ts. `PROTECTION_CLAUSES` (const) remplacée par
  `protectionClauses()` et `ENGAGED_SENDER_CLAUSES` par
  `engagedSenderClauses()` — des FONCTIONS qui renvoient {clauses, params}
  (l'ordre des deux tableaux doit rester aligné dans policyWhere).
  ABSOLUES : étoilé, tâche todo, échéance active, expéditeur ⭐, confiance
  faible, catégorie person. GRADUÉES (2 ans) : mail répondu, fil avec
  sortant, expéditeur « engagé ». Date inconnue ⇒ on protège. PIÈGE
  rencontré : j'avais écrit « répondu ET RÉCENT ⇒ supprimable » au lieu de
  « répondu ET ANCIEN ⇒ supprimable » — trouvé par le test. Autre piège :
  la protection B5 est GLOBALE à l'expéditeur, donc chaque scénario de test
  doit avoir SON expéditeur, sinon un cas masque les autres. Tests : 11.
- **P2.2 désinscription** : migration `unsubscribe_links` (Sender.
  unsubscribeHttp/Mailto/OneClick/unsubscribedAt/unsubscribeNote — sur
  l'EXPÉDITEUR, pas sur chaque mail : on se désinscrit d'un expéditeur).
  `services/unsubscribe.ts` : parseListUnsubscribe (chevrons ou non),
  hasOneClick (RFC 8058), refreshUnsubscribeLinks (job : lit l'en-tête du
  DERNIER mail de chaque expéditeur liste via
  `imapService.fetchUnsubscribeHeaders` — 2 en-têtes, aucun corps),
  listUnsubscribable, unsubscribeSender (one-click = POST
  `List-Unsubscribe=One-Click` ; mail = SMTP ; lien = JAMAIS cliqué
  automatiquement, l'URL est rendue à l'utilisateur — cliquer chez un
  expéditeur douteux confirme que l'adresse est vivante), markUnsubscribed.
  Écran `#/unsubscribe` (sidebar 🚫 + badge). rebuildSenders ne touche pas
  ces champs (vérifié). Tests : 23 asserts (dont un VRAI serveur HTTP local
  qui vérifie méthode POST + corps RFC 8058, et le cas « serveur refuse ⇒
  aucune fausse confirmation ») + 13 checks navigateur.
- RESTE À FAIRE côté utilisateur : lancer « 🔍 Chercher les liens » une
  fois (les liens ne sont pas dans l'index existant), puis se désinscrire.

**PHASE 0 « FIABILISER » COMPLÈTE (P0.1→P0.4, 28/07) — issue d'une revue
croisée Gemini 3.1 Pro + ChatGPT 5.6 commandée par l'utilisateur.** Les deux
convergeaient : le projet manquait moins d'intelligence que de BOUCLE
OPÉRATIONNELLE FIABLE. Leurs affirmations ont été VÉRIFIÉES dans le code
avant d'agir (plusieurs étaient fausses — voir ci-dessous).
- **P0.1** : `applySqlitePragmas()` dans db/client.ts (WAL + busy_timeout 5 s
  + synchronous=NORMAL, appelé depuis ensureDbReady) — sans WAL une écriture
  bloquait TOUTES les lectures. Et `reconcileMoves()` dans sync.ts : IMAP n'a
  pas de notion de déplacement, donc un mail rangé ailleurs devenait une
  nouvelle ligne et les tâches/échéances/verdicts pointaient dans le vide.
  On identifie par `internetMessageId` (DÉJÀ stocké et indexé — ChatGPT
  affirmait le contraire, c'était faux : aucune migration nécessaire) et on
  repointe Task (+ folder/uid dénormalisés)/Deadline/AttentionState/
  AnalysisFeedback. `report.movedMessages`.
- **P0.2** : detectDeadlines branché post-sync, VOLONTAIREMENT avant
  runAutoRules/runAutoRetention (une échéance protège son mail : détecter
  après aurait pu supprimer un mail porteur d'une date). Nouvelle option
  `indexedSince` (filtre sur Message.createdAt) — sans elle le scan des
  corps relisait les mêmes mails toutes les 30 min. `report.deadlinesFound`.
- **P0.3** : `services/backup.ts` — VACUUM INTO (copie cohérente même en
  écriture, contrairement à une copie de fichier en WAL), rotation 7,
  horodatage à la SECONDE (sinon deux sauvegardes rapprochées s'écrasent —
  trouvé par le test), `backups/` gitignoré. Déclenché quotidiennement
  (startAutoBackup dans index.ts) ET avant chaque applyUpdate. API
  /api/backups (+ download avec anti-traversée via listBackups). Panneau
  « 💾 Sauvegardes » dans Paramètres. RAISON D'ÊTRE : l'index se reconstruit
  depuis IMAP, mais PAS les tâches/échéances/règles/corrections manuelles.
- **P0.4** : `services/health.ts` — signal principal = FRAÎCHEUR de
  `Account.lastSyncAt` (robuste par construction : quelle que soit la panne,
  la date cesse d'avancer ; aucune migration). Seuils adaptatifs (2 cycles
  d'auto-sync, sinon 24 h/72 h), + quota ≥90/95 %, + compteur de mails non
  analysés, + erreurs des jobs en mémoire. GET /api/health. Panneau
  « 🩺 État du système » (couverture N/N) + bandeau dashboard affiché
  UNIQUEMENT si problème (un bandeau permanent ne serait plus lu).
- Tests : 12 + 7 + 16 (dont une RESTAURATION RÉELLE de la sauvegarde ouverte
  comme base de travail) + 13 asserts, et 9 + 11 checks navigateur.
- Suite décidée avec l'utilisateur : **Phase 1** (Telegram — PAS d'email :
  « je veux nettoyer mes boîtes, pas recevoir des mails en plus » ; +
  engagements sortants), puis **Phase 2** (protection GRADUÉE dans le temps
  — aujourd'hui un fil répondu une fois est protégé à vie, ce qui bloquera
  le nettoyage de masse ; + désinscription), puis Phase 3.

**Pièces jointes compactes façon Outlook (retour utilisateur 10/07 :
« quand il y a plusieurs PJ, pouvoir réduire, affichage rapide et simple,
les uns à la suite, à la mode Outlook »).** renderReaderAttachments
(app.js) refait : puces horizontales `.att-chip` qui s'enroulent (icône
par type via `attIcon`, nom ellipsé, taille, boutons icônes 👁️/⬇️) au
lieu de lignes verticales hautes ; en-tête = compteur + TAILLE TOTALE +
`⬇️ Tout (.zip)` + bouton ▾/▸ `data-att-toggle` qui REPLIE la liste
(`.att-chips.collapsed`) quand il y a plusieurs PJ (le corps du mail n'est
plus repoussé). Tests : ui-attach-perf.mjs passé à 14 checks (puces,
taille totale, réduire/déplier). Capture 9 PJ : ~5 rangées au lieu de 9
lignes.

**Barre de chargement globale (retour utilisateur 10/07 : « affiche un
loader lors de l'affichage, fais-le pour tout, simple mais efficace »).**
Un seul branchement : `request()` (api.js) incrémente un compteur
`inFlight` et émet `api-activity` (0↔1) ; `installTopLoader()` (app.js,
appelé AU DÉMARRAGE du module, avant boot — pour couvrir même login/
overview) crée `#top-loader` (barre 3 px en haut, z 200 au-dessus de tout,
gradient accent animé, `prefers-reduced-motion` OK) et l'allume/éteint,
avec anti-clignotement (n'apparaît qu'après 120 ms). `api.activity.begin/
end` exposé pour les téléchargements de PJ (fetch direct) → la barre
s'allume aussi. Tests : ui-loader.mjs (5 checks : présence, repos, allumée
sur réponse lente 700 ms, éteinte après, z ≥ 101).

**Perf & confort lecture/PJ (retours utilisateur 10/07 : « 20 s pour
ouvrir un mail », « le téléchargement des PJ pareil, on ne sait pas si
c'est en cours ou en échec », « il manque l'année », « télécharger tout
d'un coup », « juste les consulter »).** CAUSE RACINE : `readEmail` et
`downloadAttachment` faisaient `client.download(uid)` = téléchargement du
MAIL ENTIER (PJ comprises) pour afficher le texte / extraire une pièce.
Corrigé dans imap.ts : helpers bodyStructure (`listAttachmentParts`,
`findTextNode`, `decodeText` via TextDecoder+charset, `streamToBuffer`,
`formatEnvelopeAddr`) ; `readEmail` = fetchOne(envelope+bodyStructure)
puis download de la SEULE partie texte (repli `readEmailFull` sur le mail
complet si structure atypique) ; `downloadAttachment` = download de la
SEULE partie demandée (même repli) ; `downloadAllAttachments` (mail
complet, une descente) pour le zip. Vérifié : imapflow met `type` en
`text/plain`, `part`, `parameters.charset`, `disposition` — l'optim
s'active vraiment. `fmtDateTime` (api.js) : année ajoutée (bug en-tête
lecteur). Nouveau `services/zip.ts` : générateur ZIP maison (deflate +
CRC32 + EOCD, dédup des noms) — ZÉRO dépendance (archiver essayé puis
abandonné : interop ESM capricieuse + alerte sécurité), testé au vrai
`unzip`. Routes admin.ts : `?inline=1` sur la PJ (Content-Disposition
inline → « 👀 Voir » dans un onglet, PDF/image, mise en cache navigateur) ;
`GET .../attachments.zip` (cap 25 Mo). Panneau lecteur (app.js) :
`renderReaderAttachments` (👁️ Voir si type voyable, ⬇️ Télécharger,
⬇️ Tout .zip si > 1) + `downloadWithFeedback` (fetch blob : « ⏳
Préparation… » → « ✅ Téléchargé » ou « ⚠️ Réessayer » + alerte). Tests :
zip au vrai unzip (intégrité/dédup/accents) + ui-attach-perf.mjs
(10 checks : année, Voir PDF-only, retour visuel, zip). NB : la VITESSE
réelle (IMAP) reste à valider par l'utilisateur sur son PC — pas d'IMAP
en dev. NB test : `npm remove`/`install` a purgé playwright-core (non
suivi par package.json) → le réinstaller `--no-save` avant les captures.

**Correctif bruit « Aujourd'hui » (retour utilisateur 10/07, capture à
l'appui : « supprimer des newsletters reçues aujourd'hui, stupidité
incommensurable »).** today.ts : `NOISE_MIN_AGE_DAYS = 7` — un mail des
7 derniers jours n'est JAMAIS du bruit supprimable (compteurs ET aperçu ;
il bascule dans « peut attendre ») ; aperçu trié ASC — le lot de 500
traite les PLUS ANCIENS d'abord (avant : DESC ⇒ les mails du jour
partaient en premier !). Modale bruit refaite : `.modal-wide` (1100 px),
table compacte (lignes 27 px), sujets cliquables → panneau de lecture
AU-DESSUS de la modale (`.modal-overlay.under-reader` z 94 < reader 96 ;
Échap ferme le panneau puis la modale ; suppression depuis le panneau ⇒
liste rechargée). Tests : test-noise.mts (7 asserts) + ui-noise.mjs
(16 checks). NB : les modales de compose depuis le panneau restent à
z 100 (au-dessus) — ne pas toucher au z-index global du reader.

**BL1 livrée : analyse fine via Cowork — SUR LE FORFAIT, pas de clé API.**
DÉCISION UTILISATEUR (10/07) : « je veux que ça décompte de mon forfait,
pas en mode clef api » — retour à la décision d'origine (« analyse fine
par Claude via MCP »). PAS de panneau clé API/modèle/tokens dans
Paramètres : l'IA, c'est la session Cowork connectée au serveur MCP.
Livré : 9 nouveaux tools MCP (52 au total) dans `mcp/tools/assist.ts` —
get_today, get_mailbox_report, list/preview_retention_policy (lecture
seule), get_learning_suggestions, get_analysis_quality (verdicts B2), et
l'analyse fine : list_uncertain_messages (confiance faible/moyenne B4
avec contexte complet ; service `listUncertainMessages` dans
categorize.ts) + set_sender_category / set_sender_priority (mécanismes
existants, journalisés, réversibles — descriptions : proposer d'abord,
corriger après accord). Instructions serveur MCP enrichies. Tests : seed
RECALÉ sur B5 (expéditeur engagé ⇒ 0 newsletter visée ; échéance seule ⇒
protection B1 par mail — les anciennes attentes 30/5 dataient d'avant
B5), 19 asserts service, 18 checks JSON-RPC réels sur /mcp (52 tools,
appels get_today / list_uncertain_messages / set_sender_category
aller-retour manuel→auto). Tout passe par le forfait UNIQUEMENT quand
une session Cowork est ouverte — le serveur seul reste 100 % gratuit.

**B5 livrée : stratégies affinées — LA SÉRIE B (FIABILISATION) EST
COMPLÈTE (B1→B5, livrées le 10/07).** retention.ts : exclusions par
sujets sensibles attachées à la CIBLE (confirmations hors résiliation/
assurance/contrat ; notifications hors sécurité/connexion/mot de passe/
banque ; livraisons hors litige/remboursement/garantie) ; newsletters/
promos jamais si l'expéditeur a déjà compté (conversation, ⭐/répondu,
tâche) ; tout compté en protection 🛡️, libellés presets mis à jour.
deletableUnion recalculé par UNION des policyWhere (rapport A4 exact,
B1+B4+B5 inclus). learning.ts : suggestions de priorité à 2 signaux
concordants (⭐ = tout lu ET interaction ; 🔕 = jamais lu ET zéro
interaction). Tests : 15 asserts + 6 checks + régressions B2/B4.
**VALIDATION RÉELLE à faire par l'utilisateur après mise à jour :
relancer le backfill 🏷️ (Paramètres) pour poser la confiance B4, puis
examiner ~50 détections dans 🔬 Vérifier l'analyse.**

**B4 livrée : confiance de l'analyse (forte/moyenne/faible).**
Migration Message.analysisConfidence(+Reason). computeConfidence
(categorize.ts) : forte = verdict B2 correct / catégorie manuelle /
expéditeur ET intention concordants ; moyenne = un signal fort ; faible =
mot générique seul — verdict B2 « incorrect » ⇒ faible et PRIME au
recalcul. Posée post-sync (onlyMissing, avant les automatismes) + backfill
🏷️ complet. PROTECTION_CLAUSES + clause « confiance faible ⇒ jamais
supprimé ». Ligne 🎚️ dans l'analyse du mail ouvert (raison en infobulle).
Tests : 20 asserts + 4 checks + régression B2. L'utilisateur doit
relancer le backfill 🏷️ (Paramètres) pour poser la confiance sur
l'existant.

**B3 livrée : réponse attendue v2 + importants « non traités ».**
attention.ts : detectRequestKind (réponse attendue/action/question/info,
motifs FR sans « ? »), stripQuotedText (texte cité ignoré), destinataire
principal vs copie (toEmails ; en copie ⇒ seuil normal + trié après) —
ReplyItem.requestKind/inCopy, badges 🗣️/❓/cc écran Réponses, ligne 🗣️
dans l'analyse du mail ouvert (corps déquoté). importance.ts :
treatState new/untreated/treated (non traité = ancien sans réponse/tâche
même lu), score enrichi (+5/10 sans traitement N j, +10 échéance liée,
+10 expéditeur a relancé) ; écran ⭐ en 3 groupes cap 10 + « ＋N autres »,
lus inclus par défaut. Tests : 20 asserts + 10 checks navigateur.

**B2 livrée : écran « Vérifier l'analyse » (contrôle qualité).**
Modèle AnalysisFeedback + services/quality.ts : échantillon aléatoire des
5 moteurs (réponses, importants, newsletters/notifications AUTO
uniquement, candidats nettoyage via sampleRetentionTargets — protection
B1 incluse), verdict ✓/✗/? avec raison, % de précision par moteur
(corrects/(corrects+incorrects)). Les corrections sur ✗ passent par les
mécanismes EXISTANTS (catégorie manuelle, priorité ⭐/🔕, dismiss réponse)
après confirmation. API /api/review/* (journal ui_analysis_feedback),
écran #/verify (sidebar 🔬). Tests : 16 asserts + 13 checks navigateur.
L'utilisateur doit VALIDER EN RÉEL : donner quelques verdicts sur ses
vraies boîtes et vérifier que les % de précision s'affichent.

**SÉRIE B lancée (audit externe accepté : fiabilisation > nouvelles
fonctions). B1 LIVRÉE : protection centrale.** `PROTECTION_CLAUSES`
(retention.ts) injecté dans policyWhere → hérité par stratégies, Grand
ménage et auto-rétention : jamais visé si étoilé / répondu / fil avec
sortant / tâche todo liée / échéance active liée / expéditeur ⭐ toujours
important (+ garantie person inchangée). listPolicies expose
protectedCount → badge « 🛡️ N protégés ». Tests : 42 asserts (6 signaux,
aperçu scopé, prioritaire → 0). Suite : B2 écran « Vérifier l'analyse »
→ B3 réponse attendue v2 + importants non traités → B4 confiance
high/medium/low (faible ⇒ protégé) → B5 stratégies affinées — plans dans
ROADMAP.md section « Série B ». La VALIDATION RÉELLE reste chez
l'utilisateur (backfill, syncs, examen des détections).

**A6 livrée : mode apprentissage — LA SÉRIE A (CAP V3) EST COMPLÈTE.**
services/learning.ts : listSuggestions() → 3 familles AVEC PREUVE
(règles L7 suggested relancées par compte ; rétention→auto si appliquée
à la main ≥ 2 fois — comptage journal ; priorités déduites de la
lecture : ⭐ ≥ 10 mails tous lus, 🔕 ≥ 20 mails ≥ 90 % jamais ouverts,
jamais person). Valider = endpoints existants ; Ignorer = mémorisé
(modèle SuggestionDismissal). GET /api/suggestions + POST dismiss.
Écran #/suggestions + badge sidebar. Tests : 11 asserts + 14 checks +
régressions. **L'utilisateur doit VALIDER EN RÉEL sur son PC : le
backfill 🏷️ des catégories (Paramètres), une application de stratégie
de rétention, un envoi de relance ✍️, et le Grand ménage (IMAP/SMTP
mockés en dev).**

**A5 livrée : relances pilotées + priorité par relation.** Escalade
FollowupItem.stage (waiting/due/urgent >2× seuil/stale >30 j) + suggestion
FR ; écran Relances : badges, 🗄️ Clôturer sur stale, ✍️ Relancer →
modale d'envoi pré-remplie (brouillon poli, replyRef) ; accueil enrichi.
Sender.priority (migration, jamais recalculée) : ⭐ always_important +40 /
🔕 never_urgent plafond 30 dans importance.ts (raisons explicites) ;
PATCH senders accepte category/priority (journalisé) ; sélecteur Priorité
dans le tableau des expéditeurs. Tests : 13 asserts + 11 checks.
L'utilisateur doit valider un envoi de relance EN RÉEL.

**A4 livrée : « Pourquoi ma boîte est pleine ? » + Grand ménage.**
services/report.ts : generateMailboxReport() (répartition par catégorie
A1 avec %, ancienneté 4 tranches, top expéditeurs nombre/poids, par
boîte, récupérable = union distincte des cibles A3) ; runGrandMenage
(cocher = activer + appliquer, rapport par stratégie). GARANTIE « 0 mail
personnel » ancrée dans policyWhere (catégorie person exclue de toutes
les stratégies). GET /api/report + POST /api/grand-menage (job). Écran
#/bigclean (sidebar 🧺) : KPI, barres, ancienneté, top poids, lancement
coché par défaut avec aperçus. Tests : 14 asserts + 13 checks.

**A3 livrée : stratégies de rétention.** Modèle RetentionPolicy global +
7 presets DÉSACTIVÉS (OTP 7 j, livraisons 30 j, notifs 90 j, réseaux
sociaux 90 j, confirmations 6 mois, newsletters jamais lues 90 j, promos
jamais lues 30 j). services/retention.ts : simulation live, aperçu exact
cap 500, applyPolicy dry-run par défaut + corbeille lots de 200 + journal
par boîte, updatePolicy (autoApply⇒enabled), runAutoRetention post-sync.
API /api/retention* (apply = job). UI : panneau en tête de #/cleanup
(toggle, badge simulation, auto avec confirmation, aperçu, appliquer).
Tests : 13 asserts + 12 checks. L'utilisateur doit valider une
application EN RÉEL.

**A2 livrée : accueil « Aujourd'hui » orienté actions.** `#/today` est la
PAGE D'ACCUEIL par défaut (le Tableau de bord reste en 2e position).
services/today.ts : generateToday() index-only — À FAIRE (réponses
attendues filtrées par intention A1 : jamais promo/otp/livraison/
confirmation ; factures non lues ; échéances dues ; relances), IMPORTANT
(top 5 ≥ 70 non lus), PEUT ATTENDRE (non-lus hors bruit), BRUIT (4 buckets
SQL disjoints : newsletters/notifications/réseaux sociaux/pubs) ;
listNoiseMessages = aperçu exact cap 500. GET /api/today +
/api/today/noise/:bucket. Modale bruit → suppression via les endpoints
bulk existants (journalisée). Badge sidebar = nb actions. Tests :
14 asserts + 19 checks navigateur + régressions.

**A1 livrée : moteur de catégorisation (fondation Cap V3).** Migration
Sender.category/Source/Reason + Message.intent/intentReason.
services/categorize.ts : categorizeSender (10 catégories explicables,
marques d'abord puis person/newsletter/notification/ad/company),
detectIntent (10 intentions par motifs sujet, forts > question > faibles),
categorizeAccount (backfill index-only idempotent), setSenderCategory
(manual jamais écrasé, null → auto). Sync : intent posé sur les nouveaux
entrants, rebuildSenders pose category. API : intent sur les 3 listings,
stats enrichies, PATCH /accounts/:slug/senders, POST /api/categorize
(job global). UI : colonne Catégorie (sélecteur + ✍️ + tooltip raison)
dans les stats, bouton 🏷️ Recalculer dans Paramètres. Tests : 36 asserts
+ 9 checks navigateur. L'utilisateur doit lancer le backfill depuis
⚙️ Paramètres après mise à jour.

**Cap V3 acté (10/07/2026) : « Mon assistant personnel de messagerie ».**
L'utilisateur a validé un changement de philosophie : l'objectif n'est plus
de gérer des mails mais de transformer la boîte en ACTIONS (« tu dois
répondre à 4 personnes, tu peux supprimer 842 newsletters ») — sensation de
boîte vide, zéro oubli important. Plan détaillé écrit dans ROADMAP.md
section « Cap V3 » : A1 moteur de catégorisation (fondation : qui écrit /
pourquoi, index-only, explicable, migration Sender.category +
Message.intent) → A2 accueil « Aujourd'hui » orienté actions (🔥 À FAIRE /
🟠 IMPORTANT / 🟢 PEUT ATTENDRE / ⚪ BRUIT) → A3 stratégies de rétention
(OTP 7 j, livraisons 30 j, notifs 90 j, confirmations 6 mois…) → A4
« Pourquoi ma boîte est pleine ? » + Grand ménage → A5 relances pilotées
(escalade) + priorité par relation → A6 apprentissage (décisions →
suggestions). L'existant est CONSERVÉ (les briques livrées sont les organes
de la vision, la consultation L5.x reste accessible) ; garde-fous
inchangés ; heuristiques d'abord, Sonnet dédié en 2e temps. L6 reste
orthogonal, prêt le jour J.

**L7 livrée : Règles de classement.** Modèle MailRule + migration,
services/rules.ts (suggestRules 2 heuristiques index-only idempotentes :
rangement manuel récurrent dossier custom + grosses newsletters ;
previewRule ; applyRule — createFolder au besoin, move par lots de 200,
journal items, suggested→active ; updateRule avec GARDE-FOU autoApply⇒
active ; createRule manuelle ; runAutoRules post-sync non bloquant pour
les règles cochées auto). 5 tools MCP (43 au total, apply en dryRun sans
confirm). API /accounts/:slug/rules*. UI : section sidebar « RÈGLES &
AUTOMATISATION » + badge suggestions, écran #/rules groupé par boîte
(aperçu modale avec liste exacte + bouton Déplacer N, valider/ranger/
auto/pause/supprimer, ＋ Nouvelle règle avec datalist des dossiers).
Sidebar resserrée (retour utilisateur). Dossiers intelligents → backlog.
Tests : seed 37 asserts + ui-rules.mjs 14 checks + régression navquota.
L'utilisateur doit VALIDER EN RÉEL l'application d'une règle (move IMAP
réel + création de dossier — mocké en dev).

**Rattrapage maquette 2 TERMINÉ (L5.12 → L5.18, retours utilisateur
10/07).** 6 livraisons poussées : dossiers, mails suivis, écran pièces
jointes, nettoyage global, dashboard maquette, arborescence sidebar. Restent de la SPEC V2
(hors multi-utilisateur) : L7 règles de classement + dossiers
intelligents, brouillons IMAP (préparer une réponse sans l'envoyer),
mémoire métier (entities/projects) + recherche dans le CONTENU des PJ —
ces deux derniers via le Sonnet dédié, décision : après déploiement L6.

**L5.18 livrée : navigation contextuelle + recherche consultation +
quota.** Sidebar Option 1 (choix utilisateur) : Tableau de bord seul,
COMPTES, « 🌐 TOUTES LES BOÎTES », ANALYSE & ACTIONS, OUTILS ; surlignage
CONTEXTUEL (boîte précise → compte+dossier dans l'arborescence auto-
dépliée ; unifié → entrée globale) ; titre #inbox-title explicite ; champ
🔎 de filtre dans la barre d'outils inbox (param q sur les deux listings,
quickTextFilter OR sujet/adresse/nom) ; quota IMAP par boîte (migration
Account.quota*, fetchQuota RFC 2087 à chaque sync, overview expose
used/limit/free/pct, colonne Espace utilisé orange ≥90 %/rouge ≥95 % +
libre, carte vue compte, bannière 🚨 dashboard). Épinglage local REFUSÉ
par l'utilisateur (pas de divergence avec Outlook) — ⭐ suivi = l'outil.
Tests : ui-navquota.mjs (20 checks) + régressions.

**L5.17 livrée : Arborescence des boîtes dans la sidebar.** Chaque compte
a un bouton +/− qui déplie ses dossiers (rôle trié, badge non-lus, clic →
#/inbox/<slug> sur ce dossier) ; nom du compte → vue compte ; dossiers
chargés à la demande (api.folders), cache vidé à chaque refreshOverview,
état déplié dans localStorage bm.sideOpen ; vues globales inchangées.
refreshOverview scindé en renderAccountsNav()/loadSideFolders(). NB
tests : rate-limit login 10/15 min → redémarrer le serveur de test entre
les salves playwright. Tests : ui-sidetree.mjs (13 checks) + 3 suites
repassées.

**L5.16 livrée : Dashboard maquette.** « Bonjour Anthony 👋 » + date,
6 cartes KPI (nouveaux mails aujourd'hui +delta vs hier — `newMails` dans
/api/overview —, importants, réponses, relances, échéances + prochaine,
supprimables), panneau ⚡ Actions rapides, KPI remplis par les loaders
des panneaux existants. **Rattrapage maquette 2 TERMINÉ (L5.12→L5.16).**

**L5.15 livrée : Nettoyage conseillé global.** Sidebar 🧹 + `#/cleanup` :
candidats de toutes les boîtes groupés par boîte, bannière totale, mêmes
colonnes que la vue compte, bouton 🧹 → modale d'aperçu existante ;
agrégation client (boucle api.cleanup), zéro nouveau backend ; bouton
« Voir et nettoyer » sur le panneau dashboard. Seed : 12 newsletters/boîte
(candidat « sûr » par boîte).

**L5.14 livrée : Écran Pièces jointes.** Sidebar 📎 + `#/attachments` :
mails avec PJ toutes boîtes au chargement (searchIndex withAttachments),
recherche q + filtre boîte + depuis, chip compte + badge dossier +
compteur 📎N, clic → panneau avec liens ⬇️, état vide rappelant la Sync
complète. Tests : ui-attach-screen.mjs (7 checks).

**L5.13 livrée : Mails suivis (⭐).** Pseudo-rôle `flagged` (tous dossiers
hors corbeille/spam), isFlagged exposé partout, actions flag/unflag
(\\Flagged IMAP + reflet index), étoile cliquable par ligne, bouton dans
le panneau, entrée sidebar + badge. Sidebar remise à plat ordre maquette
(retour utilisateur — plus de sous-liens sous Boîte de réception ; lien
Boîte de réception = #/inbox/@inbox explicite pour réinitialiser le rôle).

**L5.12 livrée : lire les mails dans TOUS les dossiers.** Sidebar :
sous-liens 📤 Envoyés / 📝 Brouillons / 🗑️ Corbeille (#/inbox/@role, vue
unifiée par rôle — `listUnifiedInbox({role})`, param `role` sur GET
/api/messages) ; en vue unifiée le sélecteur de dossier choisit le TYPE
(inbox/sent/drafts/trash/archive/spam, plus jamais grisé) ; vue compte :
panneau « 📂 Dossiers » cliquable (compteurs, 📖 Lire → inbox sur ce
dossier) ; garde-fou dossier mémorisé inexistant → INBOX. Tests : seed
étendu (22 asserts) + ui-folders.mjs (10 checks).

**L6-prep TERMINÉE (même session) : tout le déploiement Oracle préparable
sans l'utilisateur est prêt.** `TRUST_PROXY` (trust proxy 'loopback' —
rate limits par IP réelle derrière nginx, testé XFF) + cookie session
`Secure` auto si PUBLIC_BASE_URL https ; `deploy/env.production.example` ;
`deploy/setup-oracle.sh` (installation 1-commande idempotente : Node 20,
.env secrets générés, build, pm2+systemd, nginx SSE, certbot+HSTS, récap
bearer) ; `docs/DEPLOY-ORACLE.md` (guide pas-à-pas non technique FR) ;
README §8 réécrit. Le jour J (~45 min, utilisateur requis) : VM OCI +
Security List 80/443, DNS, le copier-coller SSH, décision firewall (défaut
443 monde), URI Entra, ré-enrôlement, connecteur Cowork — détail dans la
section L6 de ROADMAP.md.

**Batch L5.6 → L5.11 TERMINÉ (demande utilisateur : « Lance L5.6 à L5.11
à suivre », un commit/push par livraison — 6 livraisons poussées dans cette
session).** Ordre suivi : L5.6 → L5.9 (priorisée sur retour utilisateur
« pas de possibilité d'ouvrir les pièces jointes ») → L5.7 → L5.8 → L5.10 →
L5.11. L'utilisateur doit encore VALIDER EN RÉEL sur son PC : pièces
jointes (téléchargement réel IMAP), actions en masse multi-boîtes, envoi
SMTP (toujours testé mocké uniquement), renommage/suppression de compte.

**L5.11 livrée : Auto-sync périodique (pré-requis L6).**
`services/autosync.ts` : `startAutoSync()` au listen d'index.ts ;
`SYNC_INTERVAL_MINUTES` (config.sync, défaut 0=off, .env.example documenté,
30 recommandé serveur) → setInterval unref ; chaque tick SAUTE si un job
tourne, sinon `startSyncAllJob('recent')` (corps factorisé de /api/sync-all
qui le réutilise) → suivi par la pastille d'activité comme une sync
manuelle. `autoSyncStatus()` dans GET /api/version → ligne du panneau
Serveur des Paramètres (désactivée / toutes les X min · prochaine dans ~Y).
Testé en réel avec intervalle 1 min : job déclenché au tick.

**L5.10 livrée : Aide & finitions UX.** Page `#/help` (7 rubriques en
dépliants : démarrage, enrôlement, sync, nettoyage, lecture/envoi/PJ,
raccourcis, pépins). Tri par colonnes inbox côté SERVEUR (`sort=date|from|
subject` + `dir` sur les deux listings, en-têtes cliquables ▲▼) ; Échap
global (panneau puis modales, confirm si brouillon `#c-text` non vide —
installGlobalUx() au boot) ; bouton ⬆ `.scroll-top` (> 600 px) ; focus auto
recherche. Tests : ui-help.mjs (13 checks).

**L5.8 livrée : Paramètres (couleur, renommage, suppression de compte).**
Écran `#/settings` (sidebar ⚙️) : couleur par boîte (input color + « auto »,
migration `Account.color`, PATCH `/api/accounts/:slug`, overview expose
color, rebuildAccountColors lit la perso d'abord), ✏️ Renommer (POST
`.../rename`, renameAccount + purge index — cache reconstructible — +
Account recréé avec couleur conservée, invite resync), 🗑️ Supprimer
(DELETE, double confirmation avec nom tapé, mails Microsoft intacts),
panneau Serveur (version, superviseur, SMTP, totaux). Journal
ui_account_color/rename/remove. Tests : curl + ui-settings.mjs (13 checks).

**L5.7 livrée : Calendrier des échéances (vue mois).** Écran `#/calendar`
(sidebar 🗓️), grille lun→dim 6 semaines, ‹ mois › + Aujourd'hui, week-ends
grisés, aujourd'hui surligné. Échéances non ignorées (proposées en
POINTILLÉ) + tâches todo datées, chips emoji type + liseré couleur compte,
cap 3/jour + « +N ». Clic jour → liste latérale, clic échéance →
openReaderFor du mail source. Lecture seule, zéro nouveau backend. Tests :
seed étendu + ui-calendar.mjs (15 checks).

**L5.9 livrée : Pièces jointes (badge, filtre, téléchargement).**
Migration Message.hasAttachments/attachmentCount ; sync fetch
`bodyStructure` → `countAttachments()` exporté (feuille avec disposition
attachment OU nom de fichier) sur les nouveaux mails seulement — backfill =
resync complète (tooltip + état vide le signalent). Filtre `withAttachments`
sur searchIndex/listFolderMessages/listUnifiedInbox (`attachments=1`), badge
📎 inbox (compteur si > 1) + recherche. Téléchargement : GET
`.../messages/:folder/:uid/attachments/:index` — imapService.
downloadAttachment (download complet + mailparser, même ordre que la liste
du panneau), Content-Disposition filename* UTF-8, 413 si mail > 25 Mo
(sizeBytes via indexedMessage étendu), 404/502 propres, index marqué lu.
Panneau : liens ⬇️ directs (cookie même origine). Tests : seed-unified.mts
(16 asserts) + ui-attachments.mjs (9 checks, corps ET download mockés
page.route) + curl 400/404/413/502.

**L5.6 livrée : Boîte unifiée + code couleur par boîte.**
`listUnifiedInbox` (search.ts, Message role=inbox tous comptes hors
supprimés, tri date desc, pagination+total) + GET `/api/messages` ; inbox
par défaut sur « 🌐 Toutes les boîtes » (localStorage `bm.inboxAccount`),
colonne Boîte + liseré coloré par ligne (posé sur le 1er td — le fond
`.unread-row td` masque un box-shadow posé sur le tr), sélection par clés
`account|folder|uid`, bulk groupé par compte+dossier (appels séquentiels à
l'API existante, totaux agrégés, mention « (N boîtes) », déplacement masqué
en unifié — dossiers ambigus) ; couleurs : palette 10 teintes attribuées
par position d'enrôlement (`rebuildAccountColors` dans refreshOverview,
repli hash), helpers `accountColor`/`accountChip`, points colorés sidebar,
chips colorées sur tous les écrans (remplace les `badge blue`). Tests :
scratchpad seed-unified.mts (8 asserts service, purge les comptes de seeds
précédents d'accounts.json) + ui-unified.mjs (18 checks playwright, bulk
mocké via page.route).

**Rattrapage maquette TERMINÉ (L5.1 → L5.5, même session).**
- **L5.2 Boîte de réception navigable** : `listFolderMessages` (index only,
  pagination offset/limit + total, filtre non-lus), `validateUids` +
  `reflectBulkInIndex` ; GET `/api/accounts/:slug/messages`, POST
  `.../messages/bulk` (corbeille/déplacer/lu/non-lu, lots de 200, journal
  `ui_bulk_*`) ; écran `#/inbox[/slug]` (sélecteurs boîte+dossier, 50/page,
  clic → lecture, sélection multiple + barre d'actions), lien sidebar 📥.
- **L5.3 Envoi** : `smtp.ts` réécrit (MailComposer → RFC822 unique, headers de
  fil, `validateRecipients`), ENABLE_SMTP_SEND **true par défaut**,
  `appendToSent` (copie Envoyés), POST `/api/accounts/:slug/send` (original
  marqué \\Answered IMAP+index si réponse, journal `ui_send_mail`), boutons
  ↩️ Répondre / ➡️ Transférer dans le panneau (citation, Re:/Fwd:), modale de
  composition, ✉️ Nouveau mail (inbox), `/api/me` → `smtpEnabled`.
- **L5.4 Analyse du mail ouvert** : POST `.../messages/analysis` (importance
  + raisons, état du fil, échéances connues + dates extraites du sujet ET du
  corps fourni par le client — zéro IMAP en plus, zéro LLM), `proposeDeadline`
  + POST `.../messages/propose-deadline` (idempotent) ; section « 🤖 Analyse
  Mail Assistant » dans le panneau (bouton ➕ Proposer par date).
- **L5.5 Tâches** : modèle `Task` + migration, `services/tasks.ts`
  (list/create/complete/dismiss/reopen, `taskFromDeadline` idempotent), 4
  tools MCP (38 au total), API `/api/tasks` + `/deadlines/:id/task`, écran
  `#/tasks` (3 onglets, titre → mail d'origine, modale ＋), badge sidebar
  (rouge si retard), panneau dashboard, ☑️ Tâche dans le panneau de lecture,
  « ☑️ → tâche » sur échéance confirmée, rubrique `tasks` du brief (chip).
- Tests par livraison : scripts service (`test-inbox/send/tasks.mts`) +
  parcours playwright (`shot-inbox/compose/analysis/tasks.mjs`), corps IMAP
  et envoi SMTP mockés via `page.route`. Un bug UX réel trouvé et corrigé
  (panneau de lecture restait ouvert après envoi).

**L5.1 livrée : Lire les mails PARTOUT (début du rattrapage maquette).**
L'utilisateur a fourni une maquette cible et acté : combler les trous
fonctionnels AVANT la L6 — voir la section « Rattrapage maquette » de
ROADMAP.md (L5.2 boîte de réception navigable → L5.3 répondre/envoyer →
L5.4 analyse du mail ouvert → L5.5 tâches). Fait dans cette passe : panneau
de lecture généralisé (`openReader(item, row, {onSeen, onRemoved})` +
`openReaderFor` + `bindOpenables`) et branché partout — sujets cliquables et
bouton 📖 Lire dans ⭐ Importants, ↩️ Réponses, ⏰ Relances (relit le mail
ENVOYÉ, « Toi (mail envoyé) »), 📅 Échéances (mail d'origine), 4 panneaux du
dashboard, sections du brief. `listDeadlines` joint le mail source
(folder/uid/msgDate/isSeen, null si disparu — `loadSourceMeta`) ; les résumés
du brief (OverdueSummary/FollowupSummary) portent folder/uid. Les actions du
panneau rafraîchissent l'écran appelant. Tests : seed-brief.mts étendu
(25 asserts) + test playwright shot-reader.mjs (7 checks, corps IMAP mocké
via page.route). NB test : mettre RATE_LIMIT_MAX haut dans le .env de test
(le rate-limit 60/min sur /api fait des 429 sur les tests navigateur).

**L5 livrée : Brief quotidien & revue hebdo.** Modèle `BriefRun` + migration
(type daily/weekly, periodStart/End, summaryJson — chaque brief archivé tel
quel). `services/brief.ts` : `generateBrief({type})` agrège depuis l'index
(aucun IMAP) : nouveaux mails de la période (approx `Message.createdAt`, hors
corbeille/spam/brouillons), importants minScore 60 (fenêtre 7 j daily / 30 j
weekly), réponses & relances en retard (60 j), échéances proposées+confirmées
sous 14 j, candidats nettoyage, volumétrie par compte ; `previousBrief` =
nouveaux depuis le brief précédent du même type ; comptes en erreur →
`skippedAccounts` sans casser le brief ; `latestBrief(type)`. 2 tools MCP
`generate_daily_brief`/`generate_weekly_review` (34 au total, descriptions
« narrer en français, tutoyer, ne pas recopier le JSON »). API : GET
`/api/brief?type=` (dernier archivé — aucun calcul au chargement du
dashboard), POST `/api/brief/generate`. UI : panneau « ☀️ Brief du jour » en
tête de dashboard — repliable (mémorisé, localStorage `bm.briefCollapsed`),
sélecteur Jour (24 h)/Semaine (7 j), chips cliquables vers les écrans,
sections top 3 (importants/échéances/réponses/relances), ligne par compte,
bouton ☀️ Régénérer. Seed : scratchpad `seed-brief.mts` (2 comptes, 15 mails,
22 asserts) ; capture navigateur OK (panneau, repli, bascule hebdo).

**L4 livrée : Export contacts.** POST `/api/accounts/:slug/export-contacts`
({senders:[{address,name}], format:'vcard'|'csv'} → fichier en pièce jointe
`contacts-<slug>-<date>.vcf|csv`, emails invalides filtrés, cap 2000, 404 si
compte inconnu) ; réutilise services/export.ts (toVCard/toOutlookCsv, v1).
UI : colonne cases à cocher dans le tableau stats de la vue compte
(statsState.selected Map — persiste au tri, vidée au rechargement), case
« tout cocher », barre `.export-bar` (compteur, boutons .vcf/.csv, tout
décocher, rappel import Outlook.com → Contacts → Gérer → Importer),
téléchargement blob avec nom de fichier issu du Content-Disposition.
Seed : scratchpad `seed-export.mts` ; test download réel via playwright.

**L3 livrée : Recherche & lecture dans l'interface.** `services/search.ts`
(recherche métadata index-only multi-comptes : q = OR sujet/adresse/nom,
filtres account/folder/from/subject/since/before/unseen, tri date desc,
limite 500 ; `indexedMessage` revalide un UID + fournit sujet/date pour le
journal ; `reflectActionInIndex` répercute delete/move/seen dans l'index sans
attendre la sync). API : GET `/api/search`, GET `/api/accounts/:slug/messages/
:folder/:uid` (corps via `imapService.readEmail` — 502 avec message clair si
boîte injoignable ; marque lu dans l'index car le FETCH pose \Seen), POST
`/api/accounts/:slug/messages/actions` (delete soft/move/seen/unseen sur UN
mail, UID revalidé contre l'index, journal `ui_delete_message`/
`ui_move_message`/`ui_mark_message` avec sujet+date). Écran `#/search` (lien
sidebar 🔎) : barre + filtres repliables, résultats groupés par compte,
panneau latéral `.reader` (corps texte scrollable, pièces jointes listées,
note de troncature, actions corbeille/déplacer/lu-non lu avec confirm ;
erreur IMAP affichée proprement, actions restent dispo). **DÉCISION
UTILISATEUR (07/2026) : aucun LLM dans cette boucle** — pas de lecture ni
d'analyse de contenu de mails par le LLM de la session de dev (trop cher) ;
l'analyse fine par LLM viendra dans un 2e temps via un Sonnet dédié (backlog
ROADMAP). Seed : scratchpad `seed-search.mts` (2 comptes, 7 mails, 13
asserts) ; test du panneau de lecture via playwright `page.route` (mock JSON).

**Phase 4 brique 4 (L2) livrée : Échéances.** Modèle `Deadline` + migration,
`services/deadlines.ts` : parseur de dates FR maison (14 tests — tournures
fortes conf 0.9, dates nues avec contexte typé conf 0.6, année implicite →
prochaine occurrence avec tolérance 45 j, heures « à 14h30 », rejets 31/02 et
« 15/300 € »), détection sujets (index) + deep corps (IMAP, cap 50/boîte),
newsletters exclues, upsert idempotent qui n'écrase jamais un statut validé.
6 tools MCP (32 au total), API + job `deadlines:<slug>`, écran `#/deadlines`
(bouton Analyser + case analyse approfondie, onglets Proposées/Confirmées/
Passées-faites/Ignorées, extrait du mail affiché), badge sidebar (proposées +
confirmées ≤ 7 j), panneau dashboard. Seed : scratchpad `seed-deadlines.mts`.

Fait : serveur MCP complet, index SQLite + syncs (incrémentales, résilientes,
« Tout synchroniser », suivi global), interface (dashboard, stats, nettoyage
fin auto/perso avec liste cochable, journal détaillé, enrôlement popup,
mise à jour 1-clic, détection superviseur). ~18 000 mails indexés, 2 boîtes.

**Phase 4 brique 3 (L1) livrée : Mails importants.** `services/importance.ts`
(score additif 0-100 plafonné, chaque règle ajoute sa raison en français :
banque/admin +30, sujet urgent +20, personne +15 / conversation +10, non lu
récent +15, question +10, montant +10, attend une réponse +10, newsletter/
notification −40 ; level high ≥ 70 / medium 40-69 / low < 40 ;
`explainImportance` par messageId ou threadId). `Sender.kind` recalculé à
chaque sync dans `rebuildSenders()` (newsletter si ≥ 80 % unsubscribe,
notification si AUTO_SENDER_RE, person si un fil de l'expéditeur contient un
sortant, sinon company — recalcul systématique v1, écraserait un kind manuel).
2 tools MCP (get_important_emails, explain_importance — 26 tools au total),
API GET `/api/attention/important` (agrégée, lecture seule en v1 : pas
d'AttentionState), écran `#/important` (KPIs par niveau, filtres minScore
40/50/70 + fenêtre 7-90 j + lus/non lus, pastille de score colorée
`.score-pill`, raisons affichées), panneau dashboard top 5, badge sidebar =
nb high. Seed : scratchpad `seed-important.mts` (2 comptes, 7 mails, asserts
Sender.kind + scores + tri + explain).

**Phase 4 briques 1 ET 2 livrées.** Brique 2 (Relances) :
`services/followups.ts` (dernier message du fil SORTANT, dossier Envoyés,
sans réponse externe ; correspondant = dernier entrant du fil sinon
destinataire ; no-reply et mails à soi-même exclus ; seuils sujet pressant
3 j / banque-admin-pro 5 j / normal 7 j), état AttentionState kind=followup
(helpers génériques snooze/dismiss/restore mutualisés dans attention.ts),
4 tools MCP (get_followups_due, snooze_followup, mark_followup_done,
restore_followup — 24 tools au total), API `/api/attention/followups`,
écran `#/followups` (onglets À relancer / En retard / Reportées / Traitées,
badge sidebar, panneau dashboard).

**Phase 4 brique 1 : Réponses oubliées.** `services/attention.ts`
(détection index-only : dernier message entrant du fil, inbox, sans réponse
sortante depuis ; newsletters/no-reply exclus ; catégories urgent 24 h /
banque-admin 48 h — IMPORTANT_SENDER_RE prudente, pas de domaines grand
public — / normal 7 j ; `reason` explicite en français), table
`AttentionState` (snooze/dismiss par fil, lié au dernier message → caduc si
un nouveau mail arrive), 5 tools MCP (get_unanswered_emails,
get_overdue_replies, snooze_reply, dismiss_reply, restore_reply), API
`/api/attention/replies` (+ snooze/dismiss/restore par compte), écran
« Réponses en attente » (onglets À traiter / En retard / Reportés / Ignorés,
badge sidebar, panneau dashboard). Journal : désormais UNE entrée par
opération de nettoyage (plus une par lot — les lots de 200 restent un
garde-fou d'exécution IMAP). Seed de test : voir scratchpad session
(2 comptes factices + 13 mails couvrant tous les cas, accounts.json factice).

## PROCHAINE ÉTAPE

**Séries A (Cap V3), B (fiabilisation) et BL1 (analyse fine MCP sur le
forfait) COMPLÈTES (livrées le 10/07).** La façade MCP est prête pour
Cowork : le sens de L6 est décuplé (c'est le déploiement qui « allume »
l'IA sur forfait). Prochaine étape logique : **L6 déploiement Oracle**
(~45 min avec l'utilisateur, tout est prêt — docs/DEPLOY-ORACLE.md :
VM OCI, DNS, script 1-commande, Entra, connecteur Cowork). Restent
aussi : VALIDATION RÉELLE de la série B par l'utilisateur (backfill 🏷️
pour poser la confiance B4, examen de détections dans 🔬 Vérifier
l'analyse, verdicts → % de précision), et le backlog (dossiers
intelligents, désinscription newsletters, brouillons IMAP, extraction
PDF factures ; « analyse LLM Sonnet dédiée » ABANDONNÉE au profit du
forfait via Cowork — décision utilisateur 10/07).
IMPORTANT avant/pendant L6 : l'utilisateur doit valider en réel (sur son
PC) les pièces jointes, les actions en masse multi-boîtes et l'ENVOI
(testé uniquement mocké — pas d'IMAP/SMTP dans l'environnement de dev).
Une livraison par session ; lire CLAUDE.md + la livraison visée uniquement ;
à la fin, cocher dans ROADMAP.md et mettre à jour l'« État » ci-dessus.

