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
claude.ai `trig_01SLhekXbwP85yQTnP32Aaof` (:17), orchestrateur + 4 sous-agents
séquentiels ; ne PAS lui donner d'autre connecteur que Boxmail. Repère 18/08 :
14 221 verdicts, 5 393 restants (1 185/24 h) ⇒ fin ~22-23/08. Compter le vivier
via `candidateWhere` d'analysis.ts, PAS un count naïf. Tourne en
**claude-sonnet-5** (forfait en limite), qualité inchangée ⇒ le laisser ainsi.
**LIMITE STRUCTURELLE** : une conversation n'analyse pas plus de ~60 mails
(elle CUMULE les lots et meurt) — contexte NEUF par lot, aucun réglage n'y fait.

**CLOS** : OCR le 13/08 (§ 39-40, 811/976 scans lisibles) ; comptes IMAP par
mot de passe (§ 41-42, `authType:'password'`, lb2i validé le 17/08, 5 254
mails). Socket timeouts IMAP ~500/j = bruit ANTÉRIEUR au 06/08.

**LIVRÉ le 18/08** (détail § 43-45) : Vue du jour repriorisée (`rangCandidat()`,
classes NON additionnables) ; **🧭 Affaires en cours** (`Engagement` +
`reviewAt` ≠ `dueAt` + brouillons — l'ouverture exige une PREUVE POSITIVE, rien
ne s'envoie seul ; 3 affaires `propose` à confirmer par lui) ; **Contexte d'un
mail** (`contexteDuMail()`, 3 focales, défaut `Lié à ce mail` = même
correspondant ET (même fil OU sujet OU dossier) ; médiane 41 → 1 mail).

**Ses 2 affaires bloquées, élucidées** : le dossier LEGALFREE (parts/holding,
1 131,26 € réglés) a été **ANNULÉ le 19/01/2026** faute de réponse de sa part ;
CAPTAIN CONTRAT (direction LB2i) est bloqué sur la **signature de Ludovic**,
avec un **prélèvement de 294,67 € rejeté le 13/12/2025**.

**LIVRÉ le 19/08** (détail § 46) — **recherche : 132 s → ~300 ms en prod**.
Coupable unique : `verdict.mentions.some`, que Prisma traduisait en sous-requête
CORRÉLÉE (41 607 mails × 29 039 mentions). Passée en SQL à la main (CTE non
corrélées, `matchMask` calculé en SQL). Le `take 400` bornait l'UNIVERS et pas
l'affichage : on classait « les plus pertinents parmi les 400 plus récents ».
Désormais phase A exhaustive compacte → tri GLOBAL → phase B d'hydratation.
Tri à 5 ordres côté serveur (défaut « les plus récents »). Les 5 976 mails
ENVOYÉS se groupent sur leur DESTINATAIRE : les 2 sens dans une même carte.

**LIVRÉ le 19/08 (2)** (détail § 47) — **« ↗️ Agrandir »** dans l'en-tête du
lecteur : bascule CSS, PAS `requestFullscreen()` (confisquerait Échap, bloquerait
les modales Répondre/Tâche/Rentila). Texte borné à 82 caractères et centré, HTML
en pleine largeur. Rien ne disparaît. Échap réduit d'abord, ferme ensuite. État
de séance, jamais sur disque (la largeur de la poignée, elle, est durable).

**À faire** :
- **Les ACCENTS de la recherche** (mesuré, non traité, à trancher AVEC lui) :
  « republique » → 64 mails, « République » → 294. Défaut silencieux. FTS5
  (`remove_diacritics 2`) réglerait le fond mais change la sémantique de
  matching (« RIB » ≠ « Ribéroux ») et exige un backfill complet.
- **Extraits des mails ENVOYÉS** (6 246, aucun) — verrou pour la détection
  automatique des affaires ET pour savoir ce qu'il a déjà demandé.
- Vue documentaire (Factures · Banque · Fiscal · Immobilier · Contrats) sans
  créer de dossier ; écran des doublons de pièces. Matière DÉJÀ extraite au
  17/08 : 858 factures, 546 reçus, 481 devis, 348 relevés, 282 contrats.
- Lot 6 : retrait des colonnes plates et de la projection de compatibilité.
- Fiscal-Manager : confirmer le premier pull réel ; puis frais Jump,
  CasaSync/livret.
- Stratégies de rétention : à n'activer QU'AVEC lui.
