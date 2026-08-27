# Boxmail / Mail Assistant — mémoire projet pour Claude Code

⚠️ **Ce fichier doit rester court (< 10 Ko).** Il est injecté dans CHAQUE
requête Claude ; sur ce poste (proxy d'entreprise Netskope) les requêtes
trop grosses sont tronquées et plantent la session (« API Error 400 …
not valid JSON »). L'historique détaillé des sessions vit dans
**`docs/JOURNAL.md`** (ajouter en tête), le plan dans **`docs/ROADMAP.md`**.

## Ce qu'est ce projet

Assistant email personnel multi-boîtes pour comptes **Outlook.com/Hotmail
personnels** (refusés par le connecteur M365 officiel de Claude). Deux façades
sur les mêmes services :
1. **Serveur MCP distant** (Streamable HTTP, 52 tools) — branché sur Claude ;
   l'analyse IA se fait LÀ, sur le forfait Claude de l'utilisateur
   (décision 10/07 : pas de clé API côté serveur) ;
2. **Interface web** « Mail Assistant » sur `/admin` — utilisée quotidiennement
   par l'utilisateur, en local sur son PC Windows.

Base : **SPEC V2** (« Assistant Exécutif Email ») — brief quotidien, mails
importants, réponses oubliées, relances, échéances, nettoyage, règles.
Décisions actées : SQLite via Prisma (PAS PostgreSQL/Redis/BullMQ),
intelligence = heuristiques serveur + analyse fine par Claude via MCP.
Production : `https://boxmail.lb2i.com` (Oracle, déployé le 28/07).

## Utilisateur

- Anthony, francophone, **non technique** : tout doit passer par l'interface,
  zéro ligne de commande (il a explicitement banni PowerShell).
- Lanceur : double-clic sur **`MailAssistant.bat`** (superviseur
  `scripts/supervisor.mjs` : pull → install → db:setup → build → serveur →
  relance auto). `start-boxmail.bat` = ancien lanceur déprécié, ne plus y toucher.
- **Mises à jour : bandeau sur le tableau de bord** → il clique → git pull +
  redémarrage. Donc : **commiter et pousser après chaque passe fonctionnelle** ;
  c'est son canal de livraison.
- 7 boîtes enrôlées : `thony56_gtr` (perso, ~20 000 mails), `Brimmo` (SARL),
  `Colocar`, `Econom`, `Altoen`, `Au-marais`, `Location_Brest`.
  Restent à ajouter : jojo56, techni-soft ×2, location-miron.

## Architecture (src/)

- `index.ts` — Express : `/mcp` (bearer), `/api` (admin, session cookie),
  `/admin` (statique `web/`), `/health`
- `mcp/tools/*` — 52 tools MCP (accounts, folders, read, write, sync, export,
  attention, échéances, briefs, tâches, règles, assist + analyse fine)
- `server/admin.ts` — API REST de l'interface
- `services/` — logique partagée MCP/interface (~30 fichiers, `ls` pour la
  liste). Ceux qui portent une contrainte non devinable :
  `imap.ts` (pool imapflow ; plages `a:b` ou `1:*`, JAMAIS de longues listes
  d'UIDs — limite Outlook), `accounts.ts` (accounts.json chiffré AES-256-GCM),
  `snippets.ts` (extraits ~500 car., ne télécharge QUE la partie texte),
  `smtp.ts` (envoi XOAUTH2 actif par défaut), `analysis.ts` (verdicts IA,
  `candidateWhere` définit le vivier), `attention.ts` / `importance.ts` /
  `today.ts` (ce qui remonte à l'écran), `engagements.ts` + `brouillons.ts`
  (affaires en cours ; brouillons SANS envoi), `correspondance.ts`
  (`contexteDuMail` : les 3 focales).
- `prisma/schema.prisma` — Account, Folder, Message, Thread, Sender…
  (SQLite, `connection_limit=1` forcé dans `db/client.ts`)
- `web/` — SPA vanilla (AUCUN framework/build) : `js/app.js`, `js/api.js`,
  `styles.css`
- CLIs de secours : enroll (+ --rename/--remove), sync, check, stats, audit

## Garde-fous NON NÉGOCIABLES

Soft delete uniquement (corbeille, jamais EXPUNGE) ; dry-run/aperçu par
défaut ; confirmation explicite ; lots de 200 ; tout journalisé dans
`logs/operations.jsonl` avec la liste exacte des mails (items) ; aucun
secret dans les logs/le repo (.env, accounts.json, data/ gitignorés) ;
les tokens ne transitent JAMAIS par Claude ni par le navigateur ;
garantie « 0 mail personnel » dans toutes les stratégies de nettoyage.

## Conventions de travail

- Branche : `claude/new-session-gutt6f` — commits en français, descriptifs,
  pousser après chaque passe (canal de livraison de l'utilisateur).
- Interface en français, tutoiement.
- Tester avant de pousser : `npx tsc --noEmit`, `node --check web/js/*.js`,
  seeds synthétiques, serveur sur PORT=8799 en test local, captures
  navigateur via playwright-core.
- `.env` de test : déjà présent en dev (sinon `npm run genkey` pour la clé).
- Pas d'IMAP réel en dev : tester DB/API/UI avec des seeds, l'utilisateur
  valide l'IMAP en réel.
- Client ID Entra réel : `00449d9d-90ad-4891-939b-7e55f4d4d816` (public,
  comptes perso uniquement, redirect `http://localhost:8787/api/enroll/callback`).
- **Fin de session : REMPLACER la section « État courant » ci-dessous
  (max ~20 lignes) et déplacer le compte rendu détaillé EN TÊTE de
  `docs/JOURNAL.md`. Ne jamais empiler l'historique ici.**

## Leçons durables (payées cher — ne pas réapprendre)

- **Toujours simuler une règle de classement sur les données réelles avant de
  l'appliquer** (passage à blanc sur les ~21 000 mails). Un test unitaire ne
  voit pas « Re: cadeau pour noah » ni « Pensez à saisir vos réponses ».
  La simulation a sauvé la mise plusieurs fois.
- **Ne coder qu'une règle qui CONVERGE sur plusieurs boîtes.** Une règle vraie
  sur une seule boîte est une coïncidence.
- **On ne migre JAMAIS la base pendant que l'app sert** (database is locked) —
  update.ts/autoupdate.ts font `db:generate` seulement ; migrations au boot.
  Et **le NOM du dossier de migration EST son identité** dans l'historique
  Prisma : l'appliquer sous un nom provisoire puis committer sous un autre fait
  échouer le boot (`duplicate column`) et coupe le serveur — constaté le 26/08.
  Réparation : `DATABASE_URL="file:../data/boxmail.db" npx prisma migrate
  resolve --applied <nom_du_depot>`.
- **Chronométrer avant d'optimiser** ; vérifier qu'un constat d'audit atteint
  réellement l'écran avant de le juger grave.
- Sur le serveur : `npm run audit -- --out logs` (écrire dans `docs/` ferait
  échouer le `git merge --ff-only` de la mise à jour).
- **Capture d'écran obligatoire avant de livrer une interface** : 6 défauts
  d'affichage attrapés ainsi le 18/08 (onglets en double, montant répété,
  champs de modale écrasés). Aucun test automatique ne les voyait.
- Pas d'octet nul littéral dans les sources (ripgrep classe le fichier
  « binaire » et le saute en silence) — utiliser l'échappement `\u0000`.
- IMAP Outlook : jamais de longues listes d'UIDs (plages uniquement) ;
  jamais de repli « mail complet » dans un rattrapage de masse.
- **NE PLUS RETIRER d'emojis existants** (marche arrière subie — il tient à
  l'identité chaleureuse ; réduire seulement les cumuls emoji+pastille+badge,
  et lister les changements AVANT toute passe de ce type).
- Jamais de classes de modale (`modal-body`/`modal-foot`) hors d'une
  modale : plusieurs écrans les ciblent par sélecteur global.
- **Le banc n'a de sens QUE sur le serveur** (local : 31 mails ⇒ 100 % de fuite,
  faux air de régression). **`db:generate` AVANT `build`** après tout changement
  de `schema.prisma`, sinon `pm2 restart` repart sur l'ancien `dist` en silence.
- **Les dossiers sont des SIGNAUX de liaison, pas des conteneurs** (31 % de
  couverture, médiane 1 mail) : pas d'ergonomie qui suppose « le dossier » au
  singulier.
- **Prisma/SQLite** : `id: { in: [...] }` > 999 valeurs fait **PANIQUER** le
  moteur (pas une erreur rattrapable) — les gros ensembles d'ids restent DANS
  SQLite ; `relation.some.champ.contains` part en sous-requête **CORRÉLÉE**,
  mortel sur un `LIKE` (132 s le 19/08) — vérifier le plan avant ; `$queryRaw`
  rend des BigInt ; chemin relatif résolu depuis `prisma/` (`file:../data/…`).
- **Attendre la disparition d'un spinner ne prouve rien** : au clic la page
  porte encore l'écran précédent, donc c'est vrai tout de suite et on relit
  l'ancien DOM. Attendre la RÉPONSE RÉSEAU.
- Un **pictogramme se vérifie au rendu** (⛶ U+26F6 = carré vide à taille de
  bouton sous Windows) ; un **gestionnaire global d'Échap existe déjà** — en
  rajouter un dans un composant fait doublon, s'accumule, et perd toujours.
- **Le corps d'un mail ne se charge pas en dev** (accounts.json local sans ses
  boîtes) : pour éprouver le rendu HTML, INTERCEPTER la réponse de lecture avec
  `page.route` — tout le code réel s'exécute alors, contrairement à une
  injection dans le DOM. Surveiller les requêtes SORTANTES quand la vie privée
  est en jeu : c'est la seule preuve qui vaut.
- **Deux rendus concurrents d'un écran posent leurs écouteurs en DOUBLE** (le
  premier câble le DOM du second) : un clic déclenchait deux ouvertures. Jeton
  de rendu incrémenté à l'entrée, abandon après l'await si un plus récent existe.
- **Une colonne ancrée qui démarre bas DÉBORDE** : `height: calc(100vh - …)`
  suppose qu'elle commence en haut. Sur la Recherche, la barre d'actions tombait
  222 px sous l'écran — recaler la colonne (elle est `sticky`) à l'ouverture.
- **Le pilote ChatGPT prend « Réflexion » pour la réponse** des modèles qui
  raisonnent (3 consultations perdues, 9 caractères chacune). Corrigé dans
  `~/.claude/tools/chatgpt/driver.mjs` ; patience portée à 300/480 s.

## Contenu des boîtes (à ne plus redécouvrir)

`Colocar` n'est PAS de la colocation : SASU de location/négoce de VÉHICULES.
`Au-marais` : location saisonnière parisienne (Airbnb, HomeExchange, Smoobu,
Stripe). `Brimmo` : quasi tout tourne autour du 46 rue de la République à
Brest. `thony56_gtr` : fonds ancien 2006-2008 (eBay, Assedic, réseaux morts).

## Accès au serveur de production

- VM Oracle : `ubuntu@51.170.60.55`, dépôt dans `/home/ubuntu/boxmail`,
  app sous pm2 (`boxmail-mcp`). Raccourci : **`ssh boxmail`** (clé
  `C:\Users\leberan\.ssh\oracle-boxmail.key`).
- **PIÈGE** : l'« Oracle Cloud Shell » de la console N'EST PAS la VM
  (symptôme : `pm2: command not found`). Invite `cloudshell` = mauvaise machine.
- Mise à jour : minuteur systemd `boxmail-update.timer` (04:00 UTC) →
  `deploy/update-boot.sh`. `AUTO_UPDATE_HOUR=-1` dans le `.env` serveur.
- Déploiement pris ? route récente → **401**, pas 404.
- Ne JAMAIS déposer de clé dans le dossier du projet (`.gitignore` couvre
  `*.key`, `*.pem`, `id_rsa*`). `npm install` COMPLET sur le serveur
  (`--omit=dev` retire @types/node et casse le build).

## État courant (remplacer, ne pas empiler — détail dans docs/JOURNAL.md)

**CAP : « RETROUVER SANS CLASSER »** (11/08) — ses boîtes sont des archives non
structurées, pas des boîtes sales. Cadre : `docs/PLAN-ASSISTANT.md`.

**LA RÈGLE QUI GOUVERNE TOUT** (§ 55) — « voilà ce que j'ai fait, interviens si
c'est faux », jamais « que veux-tu faire ? ». Écrite le 10/08, livrée seulement
le 27/08. Trois corollaires non négociables :
- Le silence peut valider un état de FONCTIONNEMENT de l'assistant (je
  surveille, je ne montre plus) ; **jamais** un état du MONDE (facture payée) —
  d'où la table `Declaration`, un fait déclaré et réversible.
- **Deux modèles séparés, jamais recombinés en un score** : le risque objectif
  et la politique de présentation. Le second n'annule jamais le premier, sinon
  le système apprend la procrastination.
- Ton : paternaliste sur l'attention, affirmatif sur la recommandation, humble
  sur les décisions conséquentes.

**DEUX TÂCHES PLANIFIÉES claude.ai tournent seules** — aucun connecteur hors
Boxmail. Même limite pour les deux : *une conversation CUMULE ses lots et meurt*
(~60 mails, ~30 dossiers) — sous-agents à contexte NEUF, coupure au TEMPS.
1. **Analyse des mails**, `trig_01SLhekXbwP85yQTnP32Aaof`, :17 chaque heure.
   Vivier à compter via `candidateWhere` d'analysis.ts, PAS un count naïf.
2. **Suivi des affaires**, `trig_01SnQhTSebN3VnzLBx7dw9NS`, **:07 chaque heure**
   (§ 54-55). Détecteur `anomalies.ts` (SQL, gratuit) → lecture par sous-agents
   → `Attente`. **Le score du détecteur n'est PAS un verdict : il se trompe une
   fois sur deux.** `npm run dossiers` pour voir sans consommer ;
   `npm run attentes:dedoublonner` (option `--ids` : ne JAMAIS appliquer le lot
   entier, 3 propositions sur 5 étaient de faux doublons).

**MESURER AVANT D'AJOUTER** : `npm run charge` — décisions demandées pour 100
mails reçus (cible 10-20 puis 5-10) ET taux de contradiction. Ne se lit JAMAIS
seul : un écran qui ne montre rien obtiendrait un score parfait. Règle de
passage : aucune nouvelle fonction d'arbitrage tant que la charge n'a pas baissé
À COUVERTURE CONSTANTE.

**PIÈGES MESURÉS, à ne pas réapprendre** :
- Un mail **sans extrait est INVISIBLE**, pas « en attente » — vérifier la
  COUVERTURE, jamais conclure d'un vivier vide (§ 53).
- Écran argent : **JAMAIS de total de portefeuille** (château à 2,68 M€, budgets
  de copropriété, pesos chiliens mêlés).
- Le **silence ne prouve rien hors d'une demande d'argent** (§ 54).
- Une **adresse commune ne fait pas un dossier** : le 46 rue de la République
  porte des dizaines de sujets distincts (charpentier, notaire, électricien).
- **Ce qui n'est pas commité ne survit pas à la nuit** : le timer de 04:04 UTC
  restaure tout depuis git. Livrer par git, pas par scp.

**À faire** :
- **« Voir l'histoire »** doit passer par les 3 focales de `contexteDuMail`
  (`sujet` → `lie` → `tout`), PAS par une recherche par mot-clé. Demandé le
  27/08 : « tu devrais avoir la liste définie des emails qui traitent ce
  dossier… sans me noyer dans tous ceux de SIDER ».
- **Gardé dans un coin** (ses mots, 27/08) : voir le FIL d'un sujet sous la
  carte et pouvoir ouvrir ces mails ; joindre au brouillon les copies des mails
  auxquels il fait référence, **uniquement au besoin**.
- **Mesurer la charge sur plusieurs jours** avant d'ajouter quoi que ce soit.
- **Le contre-audit des NON-MONTRÉS** — la seule mesure des faux négatifs.
  Auditer les cartes montrées mesure la précision, jamais ce qui est enterré.
- Les états dormante / surveillée / candidate, réveil sur ÉVÉNEMENT.
- Fusionner `#/suivi` et « Aujourd'hui » (contrats incompatibles : l'un reçoit
  `actions[]` du serveur, l'autre les calcule côté client).
- Suite de l'écran argent ; vue documentaire ; doublons de pièces ; étape 2 des
  liaisons (par EXPÉDITEUR) ; Fiscal-Manager ; rétention (QU'AVEC lui).

**Dossier LEGALFREE** (mail envoyé le 26/08, réponse attendue) : apport BRIMMO +
ALTOEN à ECONOM depuis le 24/06/2025. **2 478,68 € versés**, **rien au greffe**.
Annulé le 19/01/2026 sans remboursement, PV du CAT pourtant signé le 26/02. Deux
devis le 25/08/2026 : 1 296,01 € (déjà payé le 18/11) et 638,41 € (démission de
gérance de son frère François Jean). Autre affaire bloquée : CAPTAIN CONTRAT, en
attente de la **signature de Ludovic**, prélèvement de 294,67 € rejeté le
13/12/2025.
