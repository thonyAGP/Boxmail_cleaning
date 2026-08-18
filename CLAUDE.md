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
- **Chronométrer avant d'optimiser** ; vérifier qu'un constat d'audit atteint
  réellement l'écran avant de le juger grave.
- Sur le serveur : `npm run audit -- --out logs` (écrire dans `docs/` ferait
  échouer le `git merge --ff-only` de la mise à jour).
- Pas d'octet nul littéral dans les sources (ripgrep classe le fichier
  « binaire » et le saute en silence) — utiliser l'échappement `\u0000`.
- IMAP Outlook : jamais de longues listes d'UIDs (plages uniquement) ;
  jamais de repli « mail complet » dans un rattrapage de masse.
- **NE PLUS RETIRER d'emojis existants** (marche arrière subie — il tient à
  l'identité chaleureuse ; réduire seulement les cumuls emoji+pastille+badge,
  et lister les changements AVANT toute passe de ce type).
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
- Déploiement pris ? route récente → **401**, pas 404.
- Ne JAMAIS déposer de clé dans le dossier du projet (`.gitignore` couvre
  `*.key`, `*.pem`, `id_rsa*`). `npm install` COMPLET sur le serveur
  (`--omit=dev` retire @types/node et casse le build).

## État courant (remplacer, ne pas empiler — détail dans docs/JOURNAL.md)

**CAP : « RETROUVER SANS CLASSER »** (11/08) — ses boîtes sont des archives non
structurées, pas des boîtes sales ; `docs/PLAN-ARCHIVE.md` est CLASSÉ. Refonte
de la couche d'analyse LIVRÉE (12-13/08, lots 0 à 5) : verdict sémantique
immuable + projections. Cadre : `docs/PLAN-ASSISTANT.md`.

**Le rattrapage tourne TOUT SEUL, ×4 depuis le 14/08** : tâche planifiée
claude.ai `trig_01SLhekXbwP85yQTnP32Aaof` (:17), ORCHESTRATEUR + 4 sous-agents
séquentiels (repli mode direct 40 si Task indisponible). Ne PAS lui redonner
d'autres connecteurs que Boxmail. Repère **18/08 07 h 45 UTC : 14 221
verdicts, 5 393 sans verdict** (1 185/24 h) ⇒ fin ~22-23/08. Compter le vivier
via candidateWhere d'analysis.ts, PAS un count naïf. Tourne en
**claude-sonnet-5** depuis le 17/08 (forfait en limite) ; qualité VÉRIFIÉE
inchangée ⇒ **le laisser ainsi**, n'en reparler qu'avec lui.

**LIMITE STRUCTURELLE** : une conversation n'analyse pas plus de ~60 mails —
elle CUMULE les lots et meurt (« not valid JSON »). Contexte NEUF par lot
(d'où les sous-agents), aucun réglage n'y change rien.

**CLOS** : OCR le 13/08 (§ 39-40, 811/976 scans lisibles) ; comptes IMAP par
mot de passe (§ 41-42, `authType:'password'`, lb2i validé en réel le 17/08,
5 254 mails). Socket timeouts IMAP ~500/j = bruit ANTÉRIEUR au 06/08.

**Vue du jour repriorisée (18/08, § 43)** : le score additif saturait à 110 sur
8 candidats sur 8 — trois publicités devant une mise en demeure URSSAF de
418 €. Remplacé par `rangCandidat()` (classes NON additionnables) ;
`intent='info'` ajouté à NO_REPLY_INTENTS (le trou par lequel elles passaient).
Banc serveur : fuite 45 % → 45 %, « réponses attendues » 165 → 79.
**Le banc n'a de sens QUE sur le serveur** (en local : 31 mails ⇒ 100 % de
fuite, mesure absurde).

**À faire** :
- **« Dossiers en cours »** (demandé le 17/08) : ses 3 exemples — URSSAF via
  Mylène, parts de son frère dans la SARL (mandat d'il y a un an, rien fait
  sur Infogreffe), changement de direction LB2i payé à moitié. Ces deux
  derniers n'ont NI date, NI montant dû, NI mail entrant : aucune règle
  fondée sur les mails reçus ne les fera remonter. Objet `OpenCommitment`
  avec `reviewAt` ≠ `dueAt` (contre-revue du 18/08). Inclut les propositions
  de réponse et les relances. À cadrer.
- Vue documentaire (Factures · Banque · Fiscal · Immobilier · Contrats) sans
  créer de dossier ; écran des doublons de pièces. Matière DÉJÀ extraite au
  17/08 : 858 factures, 546 reçus, 481 devis, 348 relevés, 282 contrats.
- Lot 6 : retrait des colonnes plates et de la projection de compatibilité.
- Fiscal-Manager : confirmer le premier pull réel ; puis frais Jump,
  CasaSync/livret.
- Stratégies de rétention : à n'activer QU'AVEC lui.
