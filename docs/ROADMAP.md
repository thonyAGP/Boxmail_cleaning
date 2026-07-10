# Feuille de route — livraisons suivantes (plans d'implémentation)

> **Mode d'emploi (pour Claude Code).** Une livraison = une session. Lire
> `CLAUDE.md` (conventions, garde-fous, architecture) puis LA livraison visée
> ci-dessous — tout le contexte nécessaire y est. À la fin : tests (seed
> synthétique + `npx tsc --noEmit` + `node --check web/js/*.js` + capture
> navigateur), commit/push (canal de livraison de l'utilisateur), puis cocher
> ici et mettre à jour l'« État » de CLAUDE.md. Ne pas commencer la livraison
> suivante sans demande de l'utilisateur.

Modèle éprouvé pour chaque brique « intelligence » (suivre les briques 1-2 :
`services/attention.ts`, `services/followups.ts`) :
**service** (index-only, `reason` en français) → **tools MCP**
(`mcp/tools/attention.ts`) → **API** (`server/admin.ts`, agrégation
multi-comptes + actions par fil) → **écran** (`web/js/app.js`, cloner l'écran
Réponses/Relances : onglets, badge sidebar, panneau dashboard) → **seed de
test** (Prisma direct + `linkThreads`/`rebuildSenders`, cf. scratchpad
`seed-followups.mts` reproduit en bas de ce fichier).

---

## ✅ L0 — Relances (Phase 4, brique 2) — LIVRÉ

`services/followups.ts`, tools `get_followups_due` / `snooze_followup` /
`mark_followup_done` / `restore_followup`, API `/api/attention/followups`,
écran `#/followups`, panneau dashboard, badge sidebar.

---

## ✅ L1 — Mails importants : score /100 (Phase 4, brique 3) — LIVRÉ

`services/importance.ts` (score additif 0-100, reasons[] en français),
`Sender.kind` recalculé à chaque sync (newsletter/notification/person/company),
tools `get_important_emails` / `explain_importance`, API
`/api/attention/important`, écran `#/important` (KPIs par niveau, filtres
score/fenêtre/lus, pastilles de score), panneau dashboard top 5, badge sidebar
(nb high). Lecture seule en v1.

**Objectif.** Chaque mail entrant reçoit un score d'importance 0-100 avec
`reasons[]` explicites ; écran « ⭐ Mails importants » ; enrichissement de
`Sender.kind`.

**1. Enrichir `Sender.kind` dans `rebuildSenders()` (`services/sync.ts`)** —
classification déterministe par expéditeur, recalculée à chaque sync :
- `newsletter` si `unsubscribeCount/messageCount ≥ 0.8`
- `notification` si l'email matche `AUTO_SENDER_RE` (exporté par attention.ts)
- `person` si ≥ 1 fil de cet expéditeur contient un message sortant
  (conversation) — requête : threads distincts des messages entrants de
  l'expéditeur ∩ threads avec `isOutbound`
- `company` sinon.
Ne PAS écraser un kind posé manuellement plus tard : n'écraser que si
`kind='unknown'` ou si la valeur actuelle vient du calcul (accepté : recalcul
systématique en v1, documenté).

**2. Nouveau `services/importance.ts`** — `getImportantEmails(account, opts)`
sur le modèle des briques 1-2 (opts : `sinceDays` 30 défaut, `minScore` 40,
`includeRead` false, `limit`). Candidats : entrants inbox non supprimés.
Score additif (plafonné 100), chaque règle ajoute sa raison :
- +30 expéditeur `IMPORTANT_SENDER_RE` (banque/admin/notaire…) — raison
  « expéditeur type banque/administration »
- +20 sujet `URGENT_SUBJECT_RE`
- +15 `Sender.kind === 'person'` / +10 fil avec conversation (outbound présent)
- +15 non lu ET récent (< 7 j)
- +10 sujet contient « ? »
- +10 montant dans le sujet (`/\d+[ ,.]?\d*\s?(€|eur)/i`)
- +10 en attente de réponse (réutiliser la logique brique 1 : dernier du fil,
  pas de sortant après) — raison « attend une réponse »
- −40 `hasListUnsubscribe` ou kind newsletter/notification (rarement important)
- level : high ≥ 70, medium 40-69, low < 40.
Retour : items triés score desc avec `score`, `level`, `reasons[]`, champs
d'affichage identiques aux briques 1-2 (fromName/fromEmail/subject/date/
folder/uid/threadId/isSeen).

**3. Tools MCP** (`mcp/tools/attention.ts`) : `get_important_emails`
(sinceDays/minScore/includeRead/limit, readOnly) et `explain_importance`
(threadId ou messageId → score + reasons du mail concerné).

**4. API** : GET `/api/attention/important?sinceDays&minScore` (agrégé tous
comptes, comme les briques 1-2 — pas d'action d'état en v1 : lecture seule).

**5. Écran** `#/important` : activer le lien sidebar « ⭐ Mails importants »
(supprimer `disabled`), badge = nb high. Liste triée score desc, badge
score coloré (rouge ≥ 70, orange 40-69), raisons affichées, filtre minScore
(50/70) + fenêtre. Panneau dashboard : top 5 (remplacer la mention « ⭐ … 
arrivent dans les prochaines étapes » : ne garder que 📅 échéances).

**6. Tests (seed)** : banque non-lue avec montant (score ≥ 70) ; newsletter
(score < 40 malgré non-lu) ; personne en conversation avec question (medium+) ;
vérifier reasons non vides et tri. + capture navigateur.

---

## ✅ L2 — Échéances (Phase 4, brique 4) — LIVRÉ

Modèle `Deadline` (statuts proposed/confirmed/done/dismissed, contexte
dénormalisé), `services/deadlines.ts` (parseur FR sans dépendance — tournures
« avant le / d'ici / échéance du / rdv le »… conf 0.9, dates nues + contexte
typé conf 0.6, année implicite → prochaine occurrence (tolérance 45 j), heures ;
detect sujets + deep corps IMAP cap 50, newsletters exclues, statuts jamais
écrasés), 6 tools MCP (detect/list/confirm/dismiss/complete/restore_deadline —
32 tools au total), API `/api/attention/deadlines` + detect en job + actions,
écran `#/deadlines` (Analyser mes mails + analyse approfondie, onglets
Proposées/Confirmées/Passées-faites/Ignorées), badge sidebar, panneau dashboard.

**Objectif.** Détecter les dates limites dans les mails (sujets d'abord,
corps à la demande), les proposer, laisser l'utilisateur confirmer/ignorer.

**1. Migration Prisma** — nouveau modèle `Deadline` :
`id, accountSlug, messageId (Message.id), threadId?, title, date (DateTime),
type (payment|document|appointment|renewal|other), status
(proposed|confirmed|dismissed|done), confidence (Float 0-1), reason, sourceText,
createdAt, updatedAt` + `@@unique([accountSlug, messageId, date])` +
relation Account onDelete Cascade. Migration : `npx prisma migrate dev
--name deadlines` (le déploiement passe par `db:setup`/migrate deploy).

**2. `services/deadlines.ts`** :
- Parseur de dates FR sans dépendance (`extractDeadlines(text, refDate)`) :
  motifs « avant le 15 juillet », « d'ici le 15/07 », « échéance (du) 15/07/2026 »,
  « au plus tard le… », « à régler avant… », « rendez-vous le 15 juillet à 14h » ;
  formats numériques `15/07[/2026]` et textuels `15 juillet [2026]` ; année
  absente → prochaine occurrence future ; retour {date, type deviné par
  mots-clés (payer/facture→payment, fournir/document→document, rdv/rendez-vous
  →appointment, renouvel→renewal), confidence (0.9 si motif fort « avant le »,
  0.6 date isolée), sourceText (extrait)}.
- `detectDeadlines(rec, {sinceDays=30, deep=false, limit})` : passe 1 sur les
  SUJETS depuis l'index ; si `deep`, pré-filtrer les messages dont le sujet
  matche des mots-clés (avant|échéance|d'ici|rappel|facture|payer|rdv…) puis
  lire les CORPS via `imapService.readEmail` (cap 50 mails, progress si job).
  Upsert en `proposed` (jamais écraser un statut non-proposed). Journaliser
  l'opération (tool `detect_deadlines`, items = titres).
- `listDeadlines(account, {fromDate, toDate, status})`, `confirmDeadline`,
  `dismissDeadline`, `completeDeadline` (status done) — journalisés.

**3. Tools MCP** : `detect_deadlines` (deep param — description : lent si
deep), `list_deadlines`, `confirm_deadline`, `dismiss_deadline`,
`complete_deadline`.

**4. API** : GET `/api/attention/deadlines` (agrégé, groupé par proximité),
POST `/api/accounts/:slug/deadlines/detect` (job asynchrone si deep),
POST `/api/accounts/:slug/deadlines/:id/(confirm|dismiss|done)`.

**5. Écran** `#/deadlines` (activer lien sidebar 📅) : bouton « Analyser mes
mails » (déclenche detect, job avec progression), liste triée par date
croissante avec compte à rebours (« dans 6 jours », rouge si < 3 j), onglets
Proposées / Confirmées / Passées / Ignorées, actions par ligne. Panneau
dashboard « Échéances à venir » (top 5 confirmées+proposées futures).

**6. Tests** : parseur (10 cas FR dont année implicite et faux positifs
« avant le week-end » → pas de date), statuts, upsert non-destructif, écran.

---

## ✅ L3 — Recherche & lecture de mails dans l'interface — LIVRÉ

`services/search.ts` (recherche métadata dans l'index, multi-comptes,
`reflectActionInIndex` pour tenir l'index à jour après action), API GET
`/api/search` + GET `/api/accounts/:slug/messages/:folder/:uid` (corps via
IMAP live, 502 propre si boîte injoignable, marque lu dans l'index) + POST
`/api/accounts/:slug/messages/actions` (corbeille soft/déplacer/lu-non lu,
UID revalidé contre l'index, journalisé avec sujet+date), écran `#/search`
(barre + filtres repliables, résultats groupés par compte, panneau latéral
de lecture avec actions). AUCUN LLM dans la boucle (décision : l'analyse de
contenu par LLM viendra plus tard, via Sonnet — voir backlog).

**Objectif.** Chercher dans TOUTES les boîtes depuis l'interface et lire un
mail sans ouvrir Outlook.

- **API** : GET `/api/search?q&account&folder&from&subject&since&before&unseen
  &limit` → recherche dans l'INDEX (metadata ; `q` = OR sur subject/fromEmail/
  fromName, insensible casse via `contains`) tous comptes si `account` absent.
  GET `/api/accounts/:slug/messages/:folder/:uid` → corps via
  `imapService.readEmail` (live IMAP — côté utilisateur ça marche, pas en dev).
- **Écran** `#/search` (lien sidebar 🔎 Recherche à ajouter section
  NAVIGATION) : barre de recherche + filtres repliables, résultats groupés par
  compte, clic → panneau latéral de lecture (sujet, expéditeur, date, corps
  texte scrollable, pièces jointes listées) avec actions : 🗑️ corbeille (single,
  confirm), 📦 déplacer (select dossier), marquer lu/non lu — réutiliser les
  tools write existants côté API (`/api/accounts/:slug/messages/actions`,
  journalisés, soft delete).
- **Tests** : seed + recherche multi-comptes ; lecture mockée (readEmail
  échouera sans IMAP — tester le rendu d'erreur propre) ; capture.

---

## ✅ L4 — Export contacts depuis l'interface — LIVRÉ

POST `/api/accounts/:slug/export-contacts` (fichier en pièce jointe, emails
invalides filtrés, cap 2000), cases à cocher dans le tableau stats (sélection
persistante au tri, case « tout cocher »), barre d'export (.vcf/.csv, compteur,
mode d'emploi import Outlook.com), téléchargement via blob.

**Objectif.** Cocher des expéditeurs « légitimes » dans l'écran stats d'un
compte → télécharger un `.vcf` / `.csv` à importer dans Outlook.com.

- **API** : POST `/api/accounts/:slug/export-contacts` {senders:[{address,
  name}], format:'vcard'|'csv'} → réponse fichier (`Content-Disposition:
  attachment; filename=...`), services/export.ts existe déjà (toVCard,
  toOutlookCsv).
- **UI** : cases à cocher dans le tableau stats (vue compte) + barre d'action
  contextuelle « Exporter N contacts (.vcf) (.csv) » ; téléchargement via
  `window.location`/blob.
- **Tests** : contenu vcf/csv (échappements), capture.

---

## ✅ L5 — Brief quotidien & revue hebdo (Phase 8) — LIVRÉ

Modèle `BriefRun` (type, periodStart/End, summaryJson — chaque brief archivé),
`services/brief.ts` (`generateBrief({type:'daily'|'weekly'})` : agrégat
index-only des briques L1/1/2/L2 + nettoyage + volumétrie, `previousBrief` =
écart depuis le brief précédent, comptes en échec listés sans casser le brief ;
`latestBrief(type)`), 2 tools MCP `generate_daily_brief` /
`generate_weekly_review` (34 tools au total — descriptions qui guident Claude
à NARRER le JSON en français), API GET `/api/brief?type=` (dernier archivé,
aucun calcul) + POST `/api/brief/generate`, panneau « ☀️ Brief du jour » en
tête de dashboard (repliable — mémorisé, sélecteur Jour/Semaine, chips
cliquables vers les écrans, bouton Régénérer). Seed : scratchpad
`seed-brief.mts` (2 comptes, 15 mails, 22 asserts).

**Objectif.** « Fais-moi mon brief » : agrégat structuré prêt à narrer.

- **`services/brief.ts`** : `generateBrief({type:'daily'|'weekly', accounts?})`
  → JSON : totaux (nouveaux mails depuis N h — approx via Message.createdAt >
  now-24h), top importants (L1, minScore 60), réponses en attente overdue
  (brique 1), relances overdue (brique 2), échéances < 14 j (L2), candidats
  nettoyage (existant), volumétrie par compte. Sauvegarder dans une table
  `BriefRun` (migration : type, periodStart/End, summaryJson String) pour
  « nouveaux depuis le dernier brief ».
- **Tools MCP** : `generate_daily_brief`, `generate_weekly_review` —
  descriptions guidant Claude à NARRER le JSON en français.
- **UI** : panneau « ☀️ Brief du jour » en tête de dashboard (repliable) +
  bouton régénérer.
- **Tests** : seed multi-signaux, brief complet, capture.

---

## Rattrapage maquette (décision utilisateur 07/2026 : AVANT la L6)

L'utilisateur a fourni une maquette cible (boîte de réception navigable,
lecture/réponse, tâches, calendrier, règles…). Décision : combler les trous
fonctionnels avant le déploiement. Une livraison par session, dans cet ordre.

### ✅ L5.1 — Lire les mails PARTOUT — LIVRÉ

Le panneau de lecture (L3) est réutilisable (`openReader(item, row, {onSeen,
onRemoved})`, wrapper `openReaderFor`) et branché sur TOUS les écrans : sujets
cliquables + bouton 📖 Lire dans ⭐ Importants, ↩️ Réponses en attente,
⏰ Relances (relit le mail ENVOYÉ, étiqueté « Toi »), 📅 Échéances (mail
d'origine), les 4 panneaux du dashboard et les sections du brief.
`listDeadlines` joint désormais le mail source (folder/uid/msgDate/isSeen,
null s'il a disparu) ; les résumés du brief portent folder/uid. Actions du
panneau (corbeille/déplacer/lu) rafraîchissent l'écran appelant.

### ✅ L5.2 — Boîte de réception navigable — LIVRÉ

`listFolderMessages` (index only, offset/limit/total, filtre non-lus) +
`validateUids`/`reflectBulkInIndex` ; API GET `/api/accounts/:slug/messages`
(409 si dossier non indexé) + POST `.../messages/bulk` (corbeille soft /
déplacer / lu / non-lu, lots de 200, journal `ui_bulk_*` avec liste exacte) ;
écran `#/inbox[/slug]` (sélecteurs boîte+dossier, filtre non-lus, pagination
50/page, clic sujet → lecture, sélection multiple + barre d'actions avec
confirmations), lien sidebar 📥 + bouton « Parcourir » dans la vue compte.

### ✅ L5.3 — Répondre / transférer / nouveau mail — LIVRÉ

`smtp.ts` réécrit : message RFC822 composé une fois (MailComposer, headers
In-Reply-To/References), `validateRecipients`, ENABLE_SMTP_SEND **true par
défaut** (mais confirmation + journal à chaque envoi, jamais d'auto) ;
`imapService.appendToSent` (copie Éléments envoyés — Outlook ne le fait pas
pour SMTP) ; API POST `/api/accounts/:slug/send` (fil relié via Message-ID de
l'index, original marqué \Answered IMAP+index en cas de réponse, journal
`ui_send_mail`) ; UI : ↩️ Répondre / ➡️ Transférer dans le panneau de lecture
(citation, Re:/Fwd:), modale À/Cc/Objet/texte, ✉️ Nouveau mail (inbox),
`/api/me` expose `smtpEnabled`.

### ✅ L5.4 — Analyse du mail dans le panneau de lecture — LIVRÉ

La colonne « Analyse Mail Assistant » de la maquette, pour LE mail ouvert :
score d'importance + raisons (`explainImportance` existe déjà), réponse
attendue ?, relance suggérée ?, échéance détectée dans le corps affiché
(`extractDeadlines` sur le texte déjà téléchargé — gratuit), boutons rapides
(reporter/ignorer/confirmer l'échéance). API GET
`/api/accounts/:slug/messages/:folder/:uid/analysis`.

### ✅ L5.5 — Tâches — LIVRÉ

Modèle `Task` + migration (références souples message/deadline, contexte
dénormalisé) ; `services/tasks.ts` (list/create/complete/dismiss/reopen +
`taskFromDeadline` idempotent, tout journalisé) ; 4 tools MCP (list_tasks /
create_task / complete_task / dismiss_task — 38 au total) ; API `/api/tasks`
CRUD + POST `/api/accounts/:slug/deadlines/:id/task` ; écran `#/tasks`
(onglets À faire/Terminées/Ignorées, titre cliquable → mail d'origine,
modale ＋ Nouvelle tâche), badge sidebar (rouge si retard), panneau
dashboard, bouton ☑️ Tâche dans le panneau de lecture, « ☑️ → tâche » sur
les échéances confirmées, rubrique tasks du brief (chip cliquable).

### ✅ L5.6 — Boîte unifiée + code couleur par boîte (retour utilisateur 07/2026)

**LIVRÉE.** Vue « Toutes les boîtes » (DÉFAUT dans l'inbox, mémorisé
localStorage `bm.inboxAccount`) : backend `listUnifiedInbox` (search.ts) +
GET `/api/messages?offset&limit&unseen` — Message role=inbox tous comptes,
tri date desc, total. Couleurs : palette 10 teintes, attribution par
position d'enrôlement (`rebuildAccountColors` dans refreshOverview, repli
hash), helpers `accountColor(slug)`/`accountChip(slug)` ; point coloré
sidebar, colonne Boîte (chip) + liseré gauche coloré par ligne (sur le 1er
td — le fond des lignes non lues masquait le tr), chips colorées sur tous
les écrans (réponses, relances, importants, échéances, tâches, dashboard).
Actions en masse multi-comptes : sélection par clé `account|folder|uid`,
groupage par compte+dossier → endpoints bulk existants en séquentiel,
totaux agrégés + mention « (N boîtes) » ; déplacement masqué en unifié
(dossiers ambigus). Tests : seed-unified.mts (8 asserts service) +
ui-unified.mjs playwright (18 checks, bulk mocké via page.route).

### ✅ L5.7 — Calendrier des échéances (vue mois)

**LIVRÉE.** Écran `#/calendar` (lien sidebar 🗓️) : grille lun→dim 6
semaines fixes (jours voisins grisés), navigation ‹ mois › + bouton
Aujourd'hui, aujourd'hui surligné, week-ends grisés. Échéances non
ignorées (proposées EN POINTILLÉ + confirmées + faites) et tâches todo à
dueDate posées sur leurs jours : chip emoji type + liseré couleur du
compte, cap 3 + « +N autre(s) ». Clic jour → liste latérale (type, statut,
chip compte, expéditeur ; tâches ☑️), clic échéance → panneau de lecture
du mail source (openReaderFor). Lecture seule, AUCUN nouveau backend
(`/api/attention/deadlines` + `/api/tasks`). Tests : seed-unified.mts
étendu (5 échéances dont 1 dismissed exclue, 2 tâches dont 1 sans date
exclue) + ui-calendar.mjs (15 checks playwright : grille, événements,
pointillé, détail du jour, lecture, navigation mois).

### ✅ L5.8 — Paramètres : comptes (renommer, supprimer, couleur)

**LIVRÉE.** Écran `#/settings` (sidebar ⚙️, section NAVIGATION) : tableau
des boîtes (sélecteur de couleur natif + bouton « auto », nom, adresse,
mails indexés + dernière sync, ✏️ Renommer, 🗑️ Supprimer) + panneau
Serveur (version/commit, superviseur, SMTP, totaux index). Backend :
migration `Account.color String?` ; PATCH `/api/accounts/:slug`
({color: #rrggbb|null}, upsert DB, 400 si format invalide) ; POST
`.../rename` ({to}, slug 2-30 [a-z0-9_-], renameAccount + purge index +
recréation de la ligne Account avec la couleur conservée, needsSync) ;
DELETE `/api/accounts/:slug` (removeAccount + purge). `/api/overview`
expose `color` par compte enrôlé ; `rebuildAccountColors()` lit la couleur
perso d'abord (palette en repli) → répercutée PARTOUT (sidebar, chips,
liserés, calendrier). UI : renommage prompt+confirm avec invite resync ;
suppression double confirmation dont nom TAPÉ exactement ; messages « tes
mails chez Microsoft ne bougent pas ». Journal : ui_account_color/rename/
remove. Tests : curl (400/404, couleur, overview) + ui-settings.mjs
(13 checks playwright : couleur perso propagée au point sidebar, retour
auto, renommage, suppression annulée si nom faux puis effective).

### ✅ L5.9 — Pièces jointes : indexation légère + téléchargement (passée avant L5.7/L5.8 — retour utilisateur 07/2026 : « pas de possibilité d'ouvrir les pièces jointes »)

**LIVRÉE.** Migration `hasAttachments Boolean` + `attachmentCount Int` sur
Message ; sync : fetch `bodyStructure` → `countAttachments()` (partie
feuille avec disposition attachment OU nom de fichier — même périmètre que
mailparser dans le panneau) sur les NOUVEAUX mails uniquement (backfill =
resync complète, signalé en tooltip + état vide). Inbox unifiée/par boîte :
badge 📎 (compteur si > 1) + case « 📎 avec PJ » ; recherche : filtre +
badge. Panneau de lecture : liens ⬇️ de téléchargement direct — GET
`/api/accounts/:slug/messages/:folder/:uid/attachments/:index`
(`imapService.downloadAttachment` : download complet + mailparser, MÊME
parseur/ordre que la liste affichée ; Content-Disposition avec filename*
UTF-8 ; cap 413 si mail > 25 Mo via sizeBytes de l'index ; 404 hors index ;
502 boîte injoignable ; index marqué lu — le download pose \Seen). Tests :
seed-unified.mts étendu (16 asserts dont countAttachments multipart) +
ui-attachments.mjs (9 checks playwright : badges, filtre, liens, événement
download, nom de fichier suggéré) + curl 400/404/413/502.

### ✅ L5.10 — Aide & finitions UX

**LIVRÉE.** Page `#/help` (sidebar ❓ Aide) : 7 rubriques en dépliants
`<details>` — démarrage/MàJ (bat, bandeau, non supervisé), boîtes &
enrôlement (sélecteur de compte, navigation privée, AADSTS50011,
renommer/retirer), synchronisation (rapide vs complète, jobs persistants),
nettoyage & corbeille (~30 j, auto/perso, journal), lecture/envoi/pièces
jointes (cap 25 Mo, backfill 📎), raccourcis, en cas de pépin. Finitions :
tri par colonnes inbox (Date/Expéditeur/Sujet, serveur — `sort`/`dir` sur
listFolderMessages/listUnifiedInbox + routes, flèches ▲▼, re-clic inverse) ;
Échap GLOBAL (ferme panneau de lecture puis modales, confirmation si un
brouillon d'envoi est en cours) ; bouton ⬆ haut de page (fixe, apparaît
après 600 px) ; focus auto du champ recherche (modales déjà focus). Tests :
curl tri + ui-help.mjs (13 checks playwright).

### ✅ L5.11 — Auto-sync locale (pré-requis L6)

**LIVRÉE.** `services/autosync.ts` : `startAutoSync()` appelé au listen
d'index.ts — si `SYNC_INTERVAL_MINUTES` > 0 (config.sync, défaut 0,
documenté dans .env.example, 30 recommandé serveur), setInterval (unref)
qui à chaque tick SAUTE si n'importe quel job tourne, sinon lance
`startSyncAllJob('recent', names)` — factorisation du corps de la route
`/api/sync-all` (qui la réutilise), donc même gestionnaire de jobs → la
pastille d'activité de l'interface suit l'auto-sync comme une sync
manuelle. `autoSyncStatus()` (intervalMinutes + nextRunAt) exposé dans GET
`/api/version` → ligne « Synchronisation automatique » du panneau Serveur
des Paramètres (✕ désactivée / ✅ toutes les X min · prochaine dans ~Y min).
Test réel : serveur lancé avec SYNC_INTERVAL_MINUTES=1 → job sync-all
déclenché au tick, statut visible via /api/version et /api/jobs.

---

## Rattrapage maquette 2 (analyse d'écarts 10/07/2026 — maquette + SPEC V2)

> Retour utilisateur : « Je ne vois toujours pas la possibilité de lire mes
> emails dans les dossiers des boîtes » + « ChatGPT (SPEC V2) t'a donné des
> choses à revoir dont tu n'as pas tenu compte ». Analyse complète faite :
> écarts listés ci-dessous, dans l'ordre de valeur pour l'utilisateur.

### ✅ L5.12 — Lire les mails dans TOUS les dossiers — LIVRÉE

Réponse au blocage n°1. Sidebar : sous-liens 📤 Envoyés / 📝 Brouillons /
🗑️ Corbeille (`#/inbox/@sent|@drafts|@trash` — vue UNIFIÉE par rôle de
dossier, toutes boîtes). Backend : `listUnifiedInbox({role})` (inbox/sent/
drafts/trash/archive/spam) + param `role` sur GET /api/messages. Écran
inbox : en vue unifiée le sélecteur de dossier devient un sélecteur de
TYPE (activé, plus grisé) ; sur une boîte précise, comportement inchangé +
garde-fou dossier inexistant → retour INBOX. Vue compte : nouveau panneau
« 📂 Dossiers » cliquable (emoji par rôle, compteurs mails/non lus, 📖
Lire → ouvre l'inbox sur CE dossier de CETTE boîte). Tests : seed étendu
(sent/trash par boîte, asserts par rôle — 22 au total) + ui-folders.mjs
(10 checks playwright, lecture depuis Archive incluse).

### ✅ L5.13 — Mails suivis (drapeaux ⭐) — LIVRÉE

Pseudo-rôle `flagged` dans UNIFIED_ROLES (`listUnifiedInbox({role:
'flagged'})` : isFlagged=true TOUS dossiers hors corbeille/spam) ;
`isFlagged` exposé sur tous les items des listings/recherche. Actions
`flag`/`unflag` sur POST `.../messages/actions` (imapService.markEmails
\\Flagged, journal ui_mark_message, reflet index étendu). UI : entrée
sidebar « ⭐ Mails suivis » + badge compteur (refreshFlaggedBadge) ;
étoile ☆/⭐ cliquable sur chaque ligne de l'inbox (toutes vues) ; bouton
« ☆ Suivre / ⭐ Suivi » dans le panneau de lecture ; option « ⭐ Mails
suivis » dans le sélecteur unifié (badge dossier affiché par ligne).
Sidebar remise à plat (retour utilisateur : « tu ne peux pas mettre sous
boîte de réception les mails envoyés ») : Boîte de réception (@inbox
explicite), Mails suivis, Envoyés, Brouillons, Recherche, Corbeille au
MÊME niveau, ordre maquette. Tests : seed (3 suivis dont 1 supprimé
exclu, asserts multi-dossiers) + ui-flagged.mjs (11 checks, actions
mockées page.route).

### ⬜ L5.14 — Écran Pièces jointes

Maquette : entrée sidebar « Pièces jointes ». Écran `#/attachments` :
recherche multi-boîtes filtrée `hasAttachments` (searchIndex existant),
tri date, badge compteur, téléchargement direct (endpoint L5.9). SPEC V2
« recherche documentaire » : v1 = par métadonnées du MAIL porteur (nom de
fichier indexé = plus tard, nécessite stocker les noms à la sync).

### ⬜ L5.15 — Nettoyage conseillé global (sidebar + dashboard)

Maquette : entrée sidebar « Nettoyage conseillé » + panneau dashboard
agrégé multi-boîtes avec total « N mails peuvent être supprimés » et
bouton « Voir et nettoyer ». Backend : GET /api/cleanup agrégé (boucle
getCleanupCandidates par compte). Écran `#/cleanup` groupé par boîte,
réutilise la modale existante.

### ⬜ L5.16 — Dashboard conforme maquette

« Bonjour Anthony 👋 » + date ; carte « Nouveaux mails +N depuis hier »
(nouvelle table de snapshots quotidiens OU approx createdAt) ; panneau
« Activité récente » (3 dernières opérations du journal) ; panneau
« Actions rapides » (Rechercher, Nouveau mail, Analyser cette boîte,
Générer le brief) ; « Aperçu par compte » avec barres (existe en partie).

### SPEC V2 — points non couverts restants (hors multi-utilisateur)

- **Règles de classement + dossiers intelligents** (mail_rules,
  suggest/preview/apply, JAMAIS d'application sans validation) → **L7**,
  gros morceau déjà planifié.
- **Brouillons** (préparer une réponse déposée dans le dossier Brouillons
  via IMAP APPEND, sans envoi) → petit, à caser après L5.16.
- **Mémoire métier (entities/projects)** + **recherche documentaire dans
  le CONTENU des PJ** → nécessite l'analyse LLM (Sonnet dédié) — décision
  utilisateur 07/2026 : 2e temps, après déploiement.
- Décisions ASSUMÉES vs SPEC (actées avec l'utilisateur) : SQLite/Prisma au
  lieu de PostgreSQL+Redis+BullMQ ; interface web en plus du MCP ; pas de
  pgvector en v1.

---

## ⬜ L6 — Déploiement Oracle Cloud + connecteur Cowork

**Objectif.** Serveur accessible en HTTPS pour Claude Cowork ET pour
l'utilisateur (interface), 24/7.

**✅ L6-PREP TERMINÉE (07/2026) — tout ce qui ne nécessite pas l'utilisateur
est prêt :**
- **Auto-sync serveur** : L5.11 livrée (`SYNC_INTERVAL_MINUTES`).
- **Durcissement prod** : `TRUST_PROXY=1` (config.http) → `app.set('trust
  proxy', 'loopback')` — rate limits /api et /mcp par IP réelle
  (X-Forwarded-For) derrière nginx, usurpation impossible en direct ;
  cookie de session `Secure` automatique quand PUBLIC_BASE_URL est en
  https. Testé : XFF honoré derrière proxy (login rate-limit par IP),
  ignoré en local.
- **`deploy/env.production.example`** : .env prod commenté (secrets à
  générer, TRUST_PROXY=1, SYNC_INTERVAL_MINUTES=30, PUBLIC_BASE_URL).
- **`deploy/setup-oracle.sh`** : installation EN UNE COMMANDE, idempotente
  (Node 20, .env généré avec secrets openssl, npm install/db:setup/build,
  pm2 startOrReload + startup systemd, nginx proxy complet SSE-ready,
  certbot --redirect + HSTS, vérifications /health, récap final avec le
  bearer à coller dans Claude). `bash -n` OK.
- **`docs/DEPLOY-ORACLE.md`** : guide pas-à-pas NON TECHNIQUE en français
  (instance OCI, Security List 80/443, DNS, le copier-coller, Entra,
  ré-enrôlement recommandé, connecteur Cowork, tableau de dépannage).
- **README §8** réécrit (pointe vers le guide + le script).

**Reste à faire AVEC l'utilisateur (le jour J, ~45 min) :**
1. **Instance OCI** : créer la VM Ubuntu (Always Free), ouvrir 80/443 dans
   la Security List, récupérer l'IP publique. — console web, guidé.
2. **DNS** : A `mcp.lb2i.fr` → IP. — registrar, guidé.
3. **SSH + `bash deploy/setup-oracle.sh`** (3 questions : domaine, email
   certbot, mot de passe admin).
4. **Firewall — DÉCISION À CONFIRMER** : option retenue par défaut = 443
   ouvert au monde (IP résidentielle variable) avec bearer fort + mot de
   passe fort + rate limit + HSTS ; alternative stricte allowlist
   (deploy/oci-firewall.md).
5. **Entra** : redirect URI `https://mcp.lb2i.fr/api/enroll/callback`.
6. **Comptes** : ré-enrôler les boîtes depuis l'interface distante
   (recommandé) — alternative accounts.json+même clé documentée.
7. **Connecteur Claude** : Settings → Connectors → Add custom →
   `https://mcp.lb2i.fr/mcp` + header Bearer. Tester depuis Cowork :
   list_accounts, get_global_overview, generate_daily_brief.

---

## Backlog (petites livraisons, à caser quand pertinent)

- Renommer/supprimer un compte depuis l'interface (CLI --rename/--remove existent).
- « Nouveaux depuis hier » sur le dashboard (table de snapshots quotidiens).
- Responsive téléphone (l'utilisateur a dit PC d'abord).
- Page Aide/Support dans l'interface (raccourcis, FAQ pièges : navigation
  privée, superviseur, AADSTS50011).
- Désinscription newsletters assistée (V3 SPEC), règles de classement (Phase 7
  SPEC : suggest_mail_rules/preview/apply — gros morceau, planifier comme L7).
- Analyse fine du CONTENU des mails par LLM (résumés, tri intelligent…) :
  décision utilisateur (07/2026) — pas de lecture de mails par le LLM de la
  session de dev (trop cher) ; à faire dans un 2e temps via un modèle Sonnet
  dédié, appelé par le serveur.

---

## Annexe : squelette de seed de test (à adapter par livraison)

```ts
// npx tsx <scratchpad>/seed-X.mts — fichier .mts (ESM, top-level await OK)
import { db } from '/home/user/Boxmail_cleaning/src/db/client.js';
import { upsertAccount } from '/home/user/Boxmail_cleaning/src/services/accounts.js';
import { encrypt } from '/home/user/Boxmail_cleaning/src/services/crypto.js';
import { linkThreads, rebuildSenders } from '/home/user/Boxmail_cleaning/src/services/sync.js';
// vider les tables, créer account+folders (roles inbox/sent), messages
// (isOutbound pour les envois, inReplyTo pour les fils), puis :
await linkThreads('testbox'); await rebuildSenders('testbox');
// asserts sur le service, puis test API via serveur PORT=8799 + cookie login,
// et capture playwright-core (executablePath /opt/pw-browsers/chromium-*/chrome-linux/chrome).
```
