# Boxmail / Mail Assistant — mémoire projet pour Claude Code

⚠️ **Ce fichier est injecté dans CHAQUE requête. Il tient des RÈGLES, jamais
l'historique.** Il avait atteint 84 Ko (01/08) puis redérivé à 15 Ko (27/08) :
à chaque fois par accumulation de comptes rendus. **Au-dessus de ~12 Ko, c'est
que l'historique est revenu — le relire et le sortir.**

Un fait daté, un incident, un dossier en cours → **`docs/JOURNAL.md`** (ajouter
EN TÊTE). Le plan → **`docs/ROADMAP.md`**. Ici, et rien d'autre : ce qui sert à
travailler demain, à l'impératif, sans le récit de comment on l'a appris. Une
ligne qui commence par une date ou raconte une session n'a rien à y faire.

## Le projet

Assistant email personnel multi-boîtes pour comptes **Outlook.com/Hotmail
personnels** (refusés par le connecteur M365 officiel). Deux façades sur les
mêmes services :
1. **Serveur MCP distant** (Streamable HTTP, 52 tools) — l'analyse IA se fait
   LÀ, sur le forfait Claude de l'utilisateur : pas de clé API côté serveur ;
2. **Interface web** « Mail Assistant » sur `/admin` — son outil quotidien.

SQLite via Prisma (PAS PostgreSQL/Redis/BullMQ). Intelligence = heuristiques
serveur + analyse fine par Claude via MCP. Prod : `https://boxmail.lb2i.com`.

## L'utilisateur

- Anthony, francophone, **non technique** : tout passe par l'interface, zéro
  ligne de commande (PowerShell explicitement banni).
- Lanceur : double-clic sur **`MailAssistant.bat`** (`scripts/supervisor.mjs` :
  pull → install → db:setup → build → serveur → relance auto).
  `start-boxmail.bat` est déprécié : ne plus y toucher.
- **Son canal de livraison, c'est git** : bandeau sur le tableau de bord → il
  clique → pull + redémarrage. Donc **commiter et pousser à chaque passe**.
- 7 boîtes : `thony56_gtr` (perso, ~20 000 mails), `Brimmo` (SARL), `Colocar`,
  `Econom`, `Altoen`, `Au-marais`, `Location_Brest`. À ajouter : jojo56,
  techni-soft ×2, location-miron.

## Architecture (src/)

- `index.ts` — Express : `/mcp` (bearer), `/api` (admin, cookie de session),
  `/admin` (statique `web/`), `/health`
- `mcp/tools/*` — 52 tools ; `server/admin.ts` — API REST de l'interface
- `services/` (~30 fichiers, `ls` pour la liste). Ceux qui portent une
  contrainte non devinable : `imap.ts` (pool imapflow ; plages `a:b` ou `1:*`,
  JAMAIS de longues listes d'UIDs — limite Outlook), `accounts.ts`
  (accounts.json chiffré AES-256-GCM), `snippets.ts` (~500 car., ne télécharge
  QUE la partie texte), `smtp.ts` (XOAUTH2), `analysis.ts` (`candidateWhere`
  définit le vivier), `attention.ts` / `importance.ts` / `today.ts` (ce qui
  remonte à l'écran), `engagements.ts` + `brouillons.ts` (affaires en cours ;
  brouillons SANS envoi), `correspondance.ts` (`contexteDuMail` : les 3 focales
  `sujet` / `lie` / `tout`, hissées hors du lecteur — appelables partout).
- `prisma/schema.prisma` (SQLite, `connection_limit=1` dans `db/client.ts`)
- `web/` — SPA vanilla, AUCUN framework ni build : `js/app.js`, `js/api.js`,
  `styles.css`
- CLIs de secours : enroll (+ --rename/--remove), sync, check, stats, audit

## Garde-fous NON NÉGOCIABLES

Soft delete uniquement (corbeille, jamais EXPUNGE) ; dry-run/aperçu par défaut ;
confirmation explicite ; lots de 200 ; tout journalisé dans
`logs/operations.jsonl` avec la liste exacte des mails ; aucun secret dans les
logs ou le repo (.env, accounts.json, data/ gitignorés) ; les tokens ne
transitent JAMAIS par Claude ni par le navigateur ; garantie « 0 mail
personnel » dans toute stratégie de nettoyage.

## Conventions de travail

- Branche **`main`** (03/09 : `claude/new-session-gutt6f` l'avait rejointe au
  même commit, on travaille désormais dessus) ; commits en français, descriptifs.
- Interface en français, tutoiement. **Ne jamais retirer d'emojis existants**
  (il tient à l'identité chaleureuse) ; réduire seulement les cumuls
  emoji+pastille+badge, et lister les changements AVANT une telle passe.
- Avant de pousser : `npx tsc --noEmit`, `node --check web/js/*.js`, seeds
  synthétiques, serveur local `PORT=8799`, clic réel via playwright-core.
- Pas d'IMAP réel en dev : DB/API/UI sur seeds, l'utilisateur valide l'IMAP.
  Le `.env` de test est déjà là (sinon `npm run genkey` pour la clé).
- Client ID Entra : `00449d9d-90ad-4891-939b-7e55f4d4d816` (public, comptes
  perso, redirect `http://localhost:8787/api/enroll/callback`).
- **Fin de session : REMPLACER « État courant » (~20 lignes max) et déplacer le
  compte rendu EN TÊTE de `docs/JOURNAL.md`. Jamais d'empilement ici.**

## Règles durables (payées cher)

**Décider**
- Simuler toute règle de classement sur les DONNÉES RÉELLES : un test
  unitaire ne voit pas « Re: cadeau pour noah ».
- Ne coder qu'une règle qui CONVERGE sur plusieurs boîtes ; vraie sur une
  seule, c'est une coïncidence.
- Chronométrer avant d'optimiser ; vérifier qu'un constat d'audit atteint
  l'écran avant de le juger grave.
- Les dossiers sont des SIGNAUX, pas des conteneurs (31 % de couverture,
  médiane 1 mail) : aucune ergonomie ne suppose « le » dossier.

**Base et déploiement**
- Ne JAMAIS migrer pendant que l'app sert (database is locked) : migrations
  au boot, `db:generate` seul à la mise à jour.
- Le NOM du dossier de migration EST son identité Prisma : le renommer après
  l'avoir appliqué coupe le serveur (`duplicate column`). Réparation :
  `DATABASE_URL="file:../data/boxmail.db" npx prisma migrate resolve --applied
  <nom_du_depot>`.
- `db:generate` AVANT `build`, sinon `pm2 restart` repart sur l'ancien `dist`.
- Livrer par git, jamais par scp : le timer de 04:04 UTC restaure tout.
- Le banc n'a de sens QUE sur le serveur (en local : 100 % de fuite).
- `npm run audit -- --out logs` (écrire dans `docs/` casse le `--ff-only`).

**Prisma / SQLite**
- `id: { in: [...] }` > 999 valeurs fait PANIQUER le moteur, non rattrapable :
  garder les gros ensembles d'ids DANS SQLite.
- `relation.some.champ.contains` part en sous-requête CORRÉLÉE, mortel sur un
  `LIKE` (132 s mesurées) : vérifier le plan avant.
- `$queryRaw` rend des BigInt ; chemin relatif résolu depuis `prisma/`.

**Interface**
- **Capture obligatoire avant de livrer un écran** : aucun test automatique ne
  voit les onglets en double ni les champs écrasés. Un pictogramme se vérifie
  au rendu (⛶ U+26F6 = carré vide sous Windows).
- Attendre la RÉPONSE RÉSEAU, jamais un spinner : au clic la page porte encore
  l'écran précédent, on relirait l'ancien DOM.
- Deux rendus concurrents posent leurs écouteurs en DOUBLE : jeton de rendu
  incrémenté à l'entrée, abandon après l'await si un plus récent existe.
- Un gestionnaire global d'Échap existe déjà : ne pas en rajouter. Jamais de
  classes de modale (`modal-body`/`modal-foot`) hors d'une modale.
- Une colonne ancrée qui démarre bas DÉBORDE : `calc(100vh - …)` suppose
  qu'elle commence en haut ; recaler la colonne `sticky` à l'ouverture.
- Le corps d'un mail ne se charge pas en dev : INTERCEPTER la lecture avec
  `page.route` (le code réel s'exécute), et surveiller les requêtes SORTANTES
  dès que la vie privée est en jeu.
- Une fonction enfermée dans un écran n'existe pas ailleurs : la hisser avant
  de la réécrire.
- Pas d'octet nul littéral dans les sources (ripgrep saute le fichier en
  silence) : l'échapper.

**Connecteurs**
- Plusieurs pièces dans un mail ne font PAS plusieurs documents — ni un seul.
  Mylène scanne page par page (3 JPEG = 1 facture), mais un mail porte aussi
  18 factures Amazon ou 7 relevés mensuels. Règle dans `pages-scannees.ts` :
  images + même racine + numérotation contiguë, 2 cas sur 40. Ne l'élargir
  qu'après l'avoir resimulée sur la prod, en relisant les NON touchés.
- La taille IMAP (`BODYSTRUCTURE.size`) est la taille TRANSMISE, +37 % sur du
  base64 : passer par `tailleReelle()` dès qu'on la compare à un budget
  d'octets. Elle faussait le compteur de Fiscal-Manager (103 Mo annoncés pour
  75,3 réels) et refusait 46 mails à la lecture. MAIS laisser les seuils
  EMPIRIQUES (30 Ko « décoration ou document ») sur la valeur transmise : les
  corriger les rend 37 % plus sévères et fait perdre des justificatifs.
- Corriger un filtre ne rattrape rien : les passes ne repassent pas sur ce
  qu'elles ont marqué vu (`attachmentTextAt`, `attachmentNames`). Tout
  élargissement veut une entrée `whatsnew.ts` qui démarque les mails visés.
- Un nom de fichier venu d'un mail ne se recopie JAMAIS dans un en-tête HTTP :
  `entete-fichier.ts` (repli ASCII + `filename*`). Un accent DÉCOMPOSÉ (`e` +
  U+0301, hors Latin-1) faisait lever `setHeader` → 500 → le pull comptable
  s'arrêtait là et repartait de 0 : 8 pièces sur 286, trois semaines gelées.
- Un consommateur qui s'arrête à la première pièce en échec fige tout et ne
  DIT rien. Toute boucle d'import : mettre l'échec de côté, avancer le curseur,
  rendre compte à l'écran de la liste des échecs.

## Contenu des boîtes (à ne plus redécouvrir)

`Colocar` n'est PAS de la colocation : SASU de location/négoce de VÉHICULES.
`Au-marais` : location saisonnière parisienne (Airbnb, HomeExchange, Smoobu,
Stripe). `Brimmo` : quasi tout tourne autour du 46 rue de la République à
Brest — mais **une adresse commune ne fait pas un dossier** (charpentier,
notaire, électricien y sont des sujets distincts). `thony56_gtr` : fonds ancien
2006-2008 (eBay, Assedic, réseaux morts).

## Serveur de production

- VM Oracle : `ubuntu@51.170.60.55`, dépôt `/home/ubuntu/boxmail`, pm2
  (`boxmail-mcp`). Raccourci **`ssh boxmail`** (clé
  `C:\Users\leberan\.ssh\oracle-boxmail.key`).
- **PIÈGE** : l'« Oracle Cloud Shell » de la console N'EST PAS la VM (symptôme :
  `pm2: command not found`). Invite `cloudshell` = mauvaise machine.
- Mise à jour : `boxmail-update.timer` (04:00 UTC) → `deploy/update-boot.sh` ;
  `AUTO_UPDATE_HOUR=-1` dans le `.env` serveur.
- Déploiement pris ? une route récente rend **401**, pas 404.
- Jamais de clé dans le dossier du projet. `npm install` COMPLET sur le serveur
  (`--omit=dev` retire @types/node et casse le build).

## État courant (REMPLACER — détail dans docs/JOURNAL.md)

**CAP : « RETROUVER SANS CLASSER »** — ses boîtes sont des archives non
structurées, pas des boîtes sales. Cadre : `docs/PLAN-ASSISTANT.md`.

**LA RÈGLE QUI GOUVERNE TOUT** — « voilà ce que j'ai fait, interviens si c'est
faux », jamais « que veux-tu faire ? ». Trois corollaires :
- Le silence valide un état de FONCTIONNEMENT de l'assistant (je surveille, je
  ne montre plus) ; **jamais** un état du MONDE (facture payée) — d'où
  `Declaration`, un fait déclaré et réversible.
- **Deux modèles séparés, jamais recombinés en un score** : risque objectif et
  politique de présentation. Le second n'annule jamais le premier, sinon le
  système apprend la procrastination.
- Ton : paternaliste sur l'attention, affirmatif sur la recommandation, humble
  sur les décisions conséquentes.

**DEUX TÂCHES PLANIFIÉES claude.ai**, aucun connecteur hors Boxmail. Même
limite : *une conversation CUMULE ses lots et meurt* (~60 mails, ~30 dossiers)
— sous-agents à contexte NEUF, coupure au TEMPS.
1. **Analyse des mails**, `trig_01SLhekXbwP85yQTnP32Aaof`, :17. Compter le
   vivier via `candidateWhere` d'`analysis.ts`, PAS un count naïf.
2. **Suivi des affaires**, `trig_01SnQhTSebN3VnzLBx7dw9NS`, :07.
   `anomalies.ts` → sous-agents → `Attente`. **Le score du détecteur n'est PAS
   un verdict : il se trompe une fois sur deux.** `npm run dossiers` pour voir
   sans consommer ; `npm run attentes:dedoublonner --ids` (jamais le lot
   entier : 3 propositions sur 5 étaient de faux doublons).

**MESURER AVANT D'AJOUTER** : `npm run charge` — décisions demandées pour 100
mails reçus (cible 10-20 puis 5-10) et taux de contradiction. Ne se lit JAMAIS
seul : un écran qui ne montre rien aurait un score parfait. Aucune nouvelle
fonction d'arbitrage tant que la charge n'a pas baissé À COUVERTURE CONSTANTE.

**Pièges de conception mesurés** :
- Un mail **sans extrait est INVISIBLE**, pas « en attente » : vérifier la
  COUVERTURE, ne jamais conclure d'un vivier vide.
- **REGARDER UN COMPTEUR NE REMPLACE PAS LIRE LA LISTE.** « 7 justificatifs
  retrouvés » était vrai et cachait un billet compté 3 fois, une newsletter à
  250 € et deux commandes annulées. Corollaire : **ce qui n'a pas d'écran n'est
  pas vérifiable** — le connecteur compta a tourné 20 jours en aveugle.
- **UN TEXTE TRONQUÉ NE PERMET JAMAIS DE CONCLURE « NON ».** Trois troncatures
  d'affilée ont fait rendre 0 billet d'avion sur 94 candidats : `analysisInput`
  est un EXTRAIT choisi (~2 200 car.), `readEmail().text` s'arrête à 5 000 car.
  quand le HTML en fait 220 000, et une fenêtre de lecture trop courte rate un
  montant écrit deux lignes sous son libellé. Avant tout verdict négatif :
  d'où vient le texte, et est-il complet ?
- Écran argent : **jamais de total de portefeuille** (château à 2,68 M€,
  budgets de copropriété, pesos chiliens mêlés).
- Le **silence ne prouve rien hors d'une demande d'argent**.
- **Un mot de service n'identifie personne** : chercher « Comptabilité Client
  SIDER » sur son mot le plus LONG rendait 153 mails hors sujet. Le nom propre
  est court — écarter compta/client/service/litiges d'abord.

**Écrans livrés le 27/08** : `#/pieces-compta` (ce qui part à la compta, avec la
citation du mail et le filtre par boîte — seul LB2I part en note de frais) ;
« Voir l'histoire » branché sur les 3 focales ; modale de réponse en plan de
travail (message + appuis + fil, largeurs en `min(px, vw)` et jamais en pixels).

**À faire** :
- **Gardé dans un coin** (ses mots) : voir le FIL d'un sujet sous la carte et
  pouvoir ouvrir ces mails ; joindre au brouillon les copies des mails cités,
  **uniquement au besoin**.
- Mesurer la charge sur plusieurs jours avant d'ajouter quoi que ce soit.
- **Le contre-audit des NON-MONTRÉS** — la seule mesure des faux négatifs.
- États dormante / surveillée / candidate, réveil sur ÉVÉNEMENT.
- Fusionner `#/suivi` et « Aujourd'hui » (contrats incompatibles : l'un reçoit
  `actions[]` du serveur, l'autre les calcule côté client).
- Suite de l'écran argent ; vue documentaire ; doublons de pièces ; étape 2 des
  liaisons (par EXPÉDITEUR) ; Fiscal-Manager ; rétention (QU'AVEC lui).

**Dossiers en cours** (LEGALFREE, CAPTAIN CONTRAT…) : dans l'APP — c'est ce que
`#/suivi` sert — et au JOURNAL. Les recopier ici les ferait vieillir en silence.
