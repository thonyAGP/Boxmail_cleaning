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
- `services/` — logique partagée MCP/interface : `imap.ts` (pool imapflow
  XOAUTH2 ; IMPORTANT : plages `a:b` ou `1:*`, jamais de longues listes
  d'UIDs — limite de commande Outlook), `sync.ts` (sync incrémentale
  IMAP→SQLite), `cleanup.ts`, `accounts.ts` (accounts.json chiffré
  AES-256-GCM), `oauth.ts` (MSAL), `jobs.ts`, `oplog.ts`, `update.ts`,
  `brief.ts`, `tasks.ts`, `rules.ts`, `smtp.ts` (envoi XOAUTH2 actif par
  défaut), `snippets.ts` (extraits ~500 car., ne télécharge QUE la partie
  texte), `categorize.ts`, `retention.ts`, `analysis.ts` (verdicts IA),
  `attention.ts`, `importance.ts`, `deadlines.ts`, `today.ts`, `report.ts`,
  `learning.ts`, `quality.ts`, `unsubscribe.ts`, `backup.ts`, `health.ts`,
  `autosync.ts`, `autoupdate.ts`, `portability.ts`
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
- Interface en français, ton tutoiement.
- Tester avant de pousser : `npx tsc --noEmit`, `node --check web/js/*.js`,
  seeds synthétiques, serveur sur PORT=8799 en test local, captures
  navigateur via playwright-core.
- `.env` de test à créer (MCP_BEARER_TOKEN, TOKEN_ENCRYPTION_KEY=32 octets
  base64 via `npm run genkey`, MS_CLIENT_ID factice, PORT=8799, LOG_LEVEL=error).
- Pas d'IMAP réel accessible depuis l'environnement de dev : tester la logique
  DB/API/UI avec des seeds, l'utilisateur valide l'IMAP en réel.
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
- **Analyse massive : un agent par boîte, scopes DISJOINTS** —
  `next_analysis_batch` n'a aucun mécanisme de réservation.
- **Chronométrer avant d'optimiser** ; vérifier qu'un constat d'audit atteint
  réellement l'écran avant de le juger grave.
- Sur le serveur : `npm run audit -- --out logs` (écrire dans `docs/` ferait
  échouer le `git merge --ff-only` de la mise à jour).
- Pas d'octet nul littéral dans les sources (ripgrep classe le fichier
  « binaire » et le saute en silence) — utiliser l'échappement `\u0000`.
- IMAP Outlook : jamais de longues listes d'UIDs (plages uniquement) ;
  jamais de repli « mail complet » dans un rattrapage de masse.
- **NE PLUS RETIRER d'emojis existants** (dé-émojisation annulée après
  marche arrière — l'utilisateur tient à l'identité chaleureuse ; réduire
  seulement les cumuls emoji+pastille+badge). Lister les changements AVANT
  toute passe de ce type.
- Jamais de classes de modale (`modal-body`/`modal-foot`) hors d'une
  modale : plusieurs écrans les ciblent par sélecteur global.

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
- Vérifier qu'un déploiement a pris : `GET /api/analysis/coverage` → **401**
  (route existante) et non 404.
- Ne JAMAIS déposer de clé dans le dossier du projet (`.gitignore` couvre
  `*.key`, `*.pem`, `id_rsa*`).

## État courant (remplacer, ne pas empiler — détail dans docs/JOURNAL.md)

**CAP : « RETROUVER SANS CLASSER »** (11/08). Le nettoyage n'est plus le
chantier — mesuré, il ne retire que 966 mails. Ses boîtes ne sont pas sales,
ce sont des archives non structurées. Capacité : plus de sujet (M365 Basic,
100 Go). `docs/PLAN-ARCHIVE.md` est CLASSÉ, ne pas le relancer.

**Refonte de la couche d'analyse LIVRÉE** (12-13/08, lots 0 à 5 partiel) :
verdict sémantique immuable + projections, entrée enrichie, résolveur
d'entités, bascule des 21 consommateurs, réservation des lots. Taux de fuite
60,2 % → 51,8 %, uniquement en RETIRANT des filtres. Cadre produit :
`docs/PLAN-ASSISTANT.md`, contrat : `docs/CONTRAT-EXTRACTION.md`.

**Le rattrapage tourne TOUT SEUL** : tâche planifiée claude.ai
`trig_01SLhekXbwP85yQTnP32Aaof` (« Boxmail — rattrapage & catégorisation
continue »), toutes les heures à :17, ~40 mails par passage. Vérifiée de bout
en bout le 13/08, sur DEUX passages successifs (40 verdicts, arrêt propre,
aucun mail resté réservé). Ne PAS lui redonner d'autres connecteurs que
Boxmail. Repère au 13/08 15 h 33 : **311 verdicts, 16 905 à relire**, +40/h.

**À FAIRE EN PREMIER À LA REPRISE** : vérifier que le job tourne toujours —
compter `MailVerdict` et regarder la date du dernier ; s'il n'a rien posé
depuis plus de 2 h, lire `docs/JOURNAL.md` § 13/08 (37) avant de conclure
quoi que ce soit (il démarre avec ~9 min de retard, et j'ai déjà crié à la
panne à tort pour cette raison).

**LIMITE STRUCTURELLE À NE PAS RÉAPPRENDRE** : une conversation ne peut pas
analyser plus d'une soixantaine de mails — elle CUMULE les lots et meurt sur
« The request body is not valid JSON ». Le socle d'une session pèse déjà
~600 Ko de définitions de connecteurs (Rentila ~110 outils, Vercel ~40 ;
Boxmail = 63 Ko mesurés, donc PAS la cause). Aucun réglage de taille de lot
n'y changera rien : il faut un contexte NEUF par lot.

**À faire** :
- **Goulot n° 1 : lire les scans** (PDF sans couche texte, polices brouillées).
  Trois analyses indépendantes ont buté dessus le 13/08 — sans OCR, les
  montants restent inconnus. Bloque la vue documentaire et le fiscal.
- Puis vue documentaire (Factures · Banque · Fiscal · Immobilier · Contrats)
  sans qu'aucun dossier ne soit créé ; écran des doublons de pièces.
- Lot 6 : retrait des colonnes plates et de la projection de compatibilité.
- Fiscal-Manager : confirmer le premier pull réel ; connecteurs suivants
  (frais Jump, CasaSync/livret).
- Stratégies de rétention : à n'activer QU'AVEC lui.

**Déjà tranché par lui le 13/08, ne pas relancer** : les deux IBAN divergents
du règlement Cappelaere (25 000 €) — il a validé, l'alerte est close. Et
l'horaire du job (:17 au lieu de :15) lui est indifférent.
