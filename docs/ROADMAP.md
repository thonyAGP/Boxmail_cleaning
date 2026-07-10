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

### ✅ L5.14 — Écran Pièces jointes — LIVRÉE

Entrée sidebar « 📎 Pièces jointes » + écran `#/attachments` : au
chargement, les mails avec PJ les plus récents toutes boîtes (searchIndex
`withAttachments`, limite 200) ; barre de recherche (q), filtre par boîte,
filtre date « depuis » ; lignes avec chip compte coloré, badge dossier,
compteur 📎N ; clic → panneau de lecture avec les liens ⬇️ (endpoint
L5.9) ; état vide qui rappelle la Sync complète pour l'historique. SPEC V2
« recherche documentaire » : v1 par métadonnées du MAIL porteur — le nom
de fichier indexé viendra avec le stockage des noms à la sync (backlog).
Tests : ui-attach-screen.mjs (7 checks).

### ✅ L5.15 — Nettoyage conseillé global (sidebar + dashboard) — LIVRÉE

Entrée sidebar « 🧹 Nettoyage conseillé » + écran `#/cleanup` : tous les
candidats de toutes les boîtes, groupés par boîte (chip colorée), bannière
totale « N mails sûrs · X expéditeurs · Y boîtes », colonnes complètes
(mails, non lus, taille, risque, pourquoi), bouton 🧹 → la MODALE d'aperçu
existante (garde-fous inchangés). Agrégation côté client (boucle
api.cleanup par compte, boîtes non indexées ignorées) — aucun nouveau
backend. Dashboard : le panneau existant gagne un bouton « Voir et
nettoyer » vers l'écran. Tests : seed enrichi (12 newsletters/boîte →
candidat sûr par boîte, asserts service) + parcours navigateur (5 checks,
ouverture de la modale depuis l'écran global incluse).

### ✅ L5.16 — Dashboard conforme maquette — LIVRÉE

« Bonjour Anthony 👋 » + sous-titre tutoyé + chip date du jour ; cartes
KPI maquette : ✉️ Nouveaux mails aujourd'hui (+N vs hier — overview expose
`newMails {today, yesterday}` par Message.date rôle inbox), ⭐ importants
(à traiter), ↩️ réponses (+ « plus ancienne : X j »), ⏰ relances, 📅
échéances (+ « prochaine : date »), 🧹 supprimables (lien voir et
nettoyer) — valeurs asynchrones remplies par les loaders existants des
panneaux ; panneau « ⚡ Actions rapides » (Rechercher, Nouveau mail,
Retrouver un document, Voir le nettoyage, Calendrier, Régénérer le
brief) ; « Activité récente » et « Aperçu par compte » existaient déjà.
Tests : parcours navigateur (9 checks) + capture complète.

### ✅ L5.17 — Arborescence des boîtes dans la sidebar — LIVRÉE

Retour utilisateur : « naviguer par boîte email ou toutes en même temps
sur la consultation des envoyés, des reçus… avec des + qui déplient les
sous-dossiers d'une boîte ». Chaque compte de la sidebar a un bouton +/−
qui déplie SES dossiers (emoji par rôle, tri inbox→sent→drafts→archive→
custom→trash→spam, badge non-lus par dossier) — clic sur un dossier →
lecture directe (#/inbox/<slug> sur ce dossier). Le nom du compte reste
cliquable vers la vue compte. Dossiers chargés à la demande depuis
l'index (api.folders), cache invalidé à chaque refreshOverview (compteurs
frais), état déplié mémorisé (localStorage bm.sideOpen). Les entrées
globales (Boîte de réception, Mails suivis, Envoyés, Brouillons,
Corbeille) restent les vues « toutes les boîtes ». refreshOverview
factorisé (renderAccountsNav/loadSideFolders). Tests : ui-sidetree.mjs
(13 checks : repli par défaut, dépliage+compteurs, navigation dossier,
vue globale intacte, mémorisation après rechargement, repli) + les 3
suites précédentes repassées (recalées sur le seed élargi ; NB tests :
le rate-limit login 10/15 min impose un restart serveur entre grosses
salves de tests navigateur).

### ✅ L5.18 — Navigation contextuelle, recherche dans la consultation, quota des boîtes — LIVRÉE

Retours utilisateur 10/07 (2e vague). **Sidebar Option 1 (choix validé)** :
🏠 Tableau de bord seul en tête, COMPTES (arborescence), section « 🌐
TOUTES LES BOÎTES » (Réception/Suivis/Envoyés/Brouillons/Corbeille =
vues fusionnées), ANALYSE & ACTIONS, OUTILS (Recherche, PJ, Journal,
Paramètres, Aide). **Surlignage contextuel** : boîte précise → compte +
dossier allumés dans l'arborescence (auto-dépliée), vue unifiée → entrée
globale du bon type ; plus jamais la globale allumée quand on lit une
boîte précise. **Titre d'écran explicite** (#inbox-title) : « 📥 brimmo —
INBOX » / « 🌐 Toutes les boîtes — Envoyés ». **Recherche dans la
consultation** : champ 🔎 dans la barre d'outils inbox (Entrée pour
filtrer, ✕ pour effacer) — param `q` (OR sujet/adresse/nom, quickTextFilter)
sur listUnifiedInbox/listFolderMessages + routes ; état vide mentionne le
filtre. **Quota des boîtes** : migration Account.quotaUsed/LimitBytes,
imapService.fetchQuota (RFC 2087, supporté Outlook.com) rafraîchi en fin
de chaque sync (non bloquant), mailboxOverview expose {used, limit, free,
pct} ; Aperçu par compte → colonne « Espace utilisé » (barre + « X / Y ·
Z% », ORANGE ≥ 90 % / ROUGE ≥ 95 % + « ⚠️ libre : N »), carte 💾 de la
vue compte, bannière 🚨 « boîte(s) presque pleine(s) » sur le dashboard
avec lien nettoyage. **Épinglage : décision utilisateur = NON** (un pin
local ne se refléterait pas dans Outlook — pin propriétaire, hors IMAP ;
l'⭐ suivi synchronisé reste l'outil). Tests : curl (quota overview, q
unifié + par dossier) + ui-navquota.mjs (20 checks) + 3 suites régression.

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

## ✅ L7 — Règles de classement (Rule Engine SPEC V2) — LIVRÉ

**Suggestion → aperçu → application VALIDÉE — jamais de déplacement sans
accord.** Modèle `MailRule` (matchType sender/domain/subject, matchValue,
targetFolder, status suggested/active/paused, autoApply, reason FR,
appliedCount, unique par compte+critère). `services/rules.ts` :
- `suggestRules` (index only, idempotent, n'écrase jamais une règle
  existante) — 2 heuristiques : « tu as déjà rangé ≥3 mails de X dans le
  dossier custom Y et ≥2 attendent en inbox » ; « ≥10 newsletters de X en
  inbox → dossier Newsletters (créé au besoin) » ;
- `previewRule` (mails inbox matchés, cap 500) ; `applyRule` (createFolder
  au besoin, moveEmails par lots de 200 groupés par dossier source,
  reflectBulkInIndex, journal items complet, suggested→active,
  appliedCount) ; `updateRule` (GARDE-FOU : autoApply exige status
  active) ; `createRule` (manuelle, active) ; `deleteRule` ;
- `runAutoRules` : hook post-sync (sync.ts, non bloquant, import
  dynamique) — UNIQUEMENT les règles actives cochées auto, journal
  `rule_auto_apply`, progress dans le job de sync.
5 tools MCP (suggest/list/preview/apply — dryRun si confirm≠true —/
set_status ; **43 tools au total**). API REST : GET/POST
`/accounts/:slug/rules[(/suggest|/:id/preview|/:id/apply)]`, PATCH/DELETE
`/:id`. UI : section sidebar « RÈGLES & AUTOMATISATION » + badge
(suggestions en attente), écran `#/rules` groupé par boîte — phrase « Si
expéditeur = X → déplacer vers 📂 Y » + raison, badges état/auto/N à
ranger, actions Aperçu (modale : liste exacte + bouton Déplacer N) /
Valider / Ranger N / auto / Pause / Supprimer, modale ＋ Nouvelle règle
(datalist des dossiers existants). Sidebar resserrée (retour utilisateur :
espaces réduits). Tests : seed étendu (dossier custom Locations + airbnb
rangés/en attente — 37 asserts dont idempotence et garde-fou auto) +
ui-rules.mjs (14 checks, apply mocké) + régression ui-navquota.
**Dossiers intelligents (vues enregistrées) : reportés au backlog** —
moins prioritaires que le déploiement L6.

---

## Cap V3 (décision utilisateur 10/07/2026) — « Mon assistant personnel de messagerie », orienté ACTIONS

> **La promesse.** « En ouvrant l'application 5 minutes chaque matin, tu peux
> être certain qu'aucun email important ne t'échappera, tout en réduisant
> progressivement des années d'accumulation de messages inutiles. »
>
> **Le renversement.** Le mail devient un objet technique. L'utilisateur ne
> travaille plus avec des mails mais avec des ACTIONS : « Tu dois répondre à
> 4 personnes. Tu dois payer une facture. Tu peux supprimer 842 newsletters.
> Tout le reste peut être ignoré. »

**Principes actés :**
1. **Rien n'est jeté de l'existant.** Les briques déjà livrées (réponses en
   attente, relances, échéances, importance explicable, nettoyage, règles L7,
   brief, tâches) SONT les organes de la vision — elles changent de place,
   pas de nature. La consultation classique (inbox, dossiers, recherche,
   lecture — L5.x) reste accessible, mais n'est plus la porte d'entrée.
2. **Tout est explicable.** Jamais de « score IA » opaque : chaque décision
   (catégorie, priorité, proposition de suppression) porte ses raisons en
   français, comme `importance.ts` le fait déjà.
3. **Garde-fous inchangés et non négociables** : simulation/aperçu d'abord,
   validation explicite, soft delete, lots de 200, journal complet.
   L'apprentissage SUGGÈRE, il n'agit jamais seul tant que l'utilisateur n'a
   pas coché « auto » (mécanique L7 existante).
4. **Heuristiques d'abord, LLM ensuite.** Les moteurs ci-dessous sont
   index-only (sujets, expéditeurs, en-têtes, comportement). L'analyse fine
   du CONTENU (intention sémantique, extraction PDF de factures) reste actée
   pour le 2e temps via le Sonnet dédié (décision 07/2026, coût).

**Ce que la vision demande et qui existe déjà** (à réutiliser, pas à
réécrire) : score explicable = `importance.ts` (reasons[]) ; « il attend une
réponse » = `attention.ts` ; suivi des conversations sans réponse =
`followups.ts` ; échéances = `deadlines.ts` ; « qui écrit » v1 =
`Sender.kind` ; apprentissage v1 = `rules.ts/suggestRules` (observe déjà les
rangements manuels) ; rapport de boîte v1 = stats senders + nettoyage
auto/perso ; brief = `brief.ts`. Les livraisons A1-A6 étendent ces organes.

### ✅ A1 — Moteur de catégorisation (LA fondation : qui écrit, pourquoi) — LIVRÉE

**Livré.** Migration `categorize` : `Sender.category/categorySource/
categoryReason` + `Message.intent/intentReason`. `services/categorize.ts` :
`categorizeSender` (10 catégories — admin/bank/insurance/social/marketplace
d'abord (regex tokens à frontières de mots), puis person (conversation OU
domaine grand public), newsletter (ratio unsub ≥ 0.8), notification
(AUTO_SENDER_RE), ad, company par défaut — chaque décision avec sa raison
FR) ; `detectIntent` (10 intentions par motifs sujet FR/EN — les motifs
FORTS otp/invoice/shipping/appointment/reminder priment sur une question,
les FAIBLES confirmation/document/promo cèdent devant « le sujet pose une
question » → reply_expected ; listes de diffusion et robots exclus de
reply_expected) ; `categorizeAccount` (backfill index-only par lots de
1000, écritures groupées par (intent, raison), idempotent) ;
`setSenderCategory` (correction manuelle, `manual` JAMAIS écrasé par la
sync ; null → retour auto recalculé immédiatement). Sync : intent calculé
à l'indexation des nouveaux entrants ; `rebuildSenders` pose
category/categoryReason en respectant `manual`. API : `intent` exposé sur
les 3 listings (recherche, dossier, unifié) ; stats expéditeurs enrichies
(category/Source/Reason) ; PATCH `/accounts/:slug/senders`
({email, category|null}, 400 catégorie inconnue, 404 expéditeur inconnu,
journal `ui_sender_category`) ; POST `/api/categorize` (job global toutes
boîtes, 409 si déjà en cours). UI : colonne « Catégorie » dans le tableau
des expéditeurs (sélecteur 10 catégories + « ↺ automatique », tooltip =
raison, ✍️ si manuel) ; Paramètres → « 🏷️ Recalculer les catégories ».
Tests : seed-categorize.mts (36 asserts) + ui-categorize.mjs (9 checks
navigateur, PATCH réel). NB : le backfill sur les vraies boîtes se lance
depuis ⚙️ Paramètres (ou attendre les prochaines syncs pour les nouveaux
mails).

Tout le cap V3 s'appuie dessus. Deux axes calculés par heuristiques
index-only, stockés et EXPLIQUÉS :
- **Migration** : `Sender.category` (person, family_friend, company, bank,
  insurance, admin, client_supplier, marketplace, social, newsletter,
  notification, ad, noreply) — remplace/élargit `kind` en gardant la
  compat ; `Message.intent` (reply_expected, invoice, confirmation,
  shipping, otp, appointment, document, reminder, info, promo) +
  `Message.intentReason` court.
- **`services/categorize.ts`** : classification expéditeur (regex domaines
  banques/assurances/admin FR, marketplaces, réseaux sociaux, motifs
  noreply/notification existants, comportement : conversation → person) ;
  intention par motifs sujet FR/EN (« votre commande/colis », « code de
  vérification », « facture/à régler », « rendez-vous », « re: » +
  question…) + en-têtes déjà indexés (List-Unsubscribe, auto-submitted).
  Idempotent, ne JAMAIS écraser une catégorie posée manuellement
  (`categorySource: auto|manual`).
- Calcul à la sync (nouveaux mails) + **job de backfill** sur tout l'index
  (index-only donc rapide) lancé depuis Paramètres.
- API : catégorie/intention exposées sur tous les listings ; PATCH pour
  corriger un expéditeur à la main (vue stats) — correction = signal
  d'apprentissage (A6).
- Tests : jeu de ~30 mails synthétiques couvrant chaque catégorie/intention.

### ✅ A2 — Accueil « Aujourd'hui » orienté actions — LIVRÉE

**Livré.** `services/today.ts` : `generateToday()` (agrégat index-only
multi-comptes, comptes en erreur → skippedAccounts sans casser l'écran) —
🔥 À FAIRE = réponses attendues actives (les intentions A1
promo/otp/shipping/confirmation n'y entrent JAMAIS — filtre par messageId),
factures non lues (intent invoice, 30 j), échéances dues (proposed+
confirmed ≤ fin de journée, dépassées 90 j max), relances actives — tri
retard d'abord ; 🟠 IMPORTANT = top 5 minScore 70 non lus 7 j ;
🟢 PEUT ATTENDRE = non-lus inbox hors bruit/factures ; ⚪ BRUIT = 4 buckets
disjoints par CASE SQL (newsletter > notification > social > pub/intent
promo) avec compte/non-lus/octets ; flag `categorized` si aucune catégorie
calculée. `listNoiseMessages(bucket)` = liste EXACTE cap 500 (garde-fou
aperçu avant action). API : GET `/api/today`, GET `/api/today/noise/:bucket`
(400 bucket inconnu). UI : écran `#/today` = PAGE D'ACCUEIL PAR DÉFAUT
(sidebar « ☀️ Aujourd'hui » + badge nb actions ; le Tableau de bord reste
accessible en 2e position) — phrases d'action (« Répondre à X — attend
depuis N j », 💶 facture, 📅 échéance avec badge rouge dépassée/aujourd'hui,
⏰ relancer), chip boîte + 📖 Lire (items gardés en mémoire, pas en
attribut — apostrophes), modale bruit (liste exacte, note cap 500, double
confirmation, suppression par les endpoints bulk EXISTANTS groupés
compte+dossier — journal ui_bulk_delete conservé, récap, re-render).
Notice si catégories jamais calculées → lien Paramètres. Tests :
seed-today.mts (14 asserts, rejoue seed-categorize) + ui-today.mjs
(19 checks, bulk + corps mockés) + régression ui-categorize.

Remplace le dashboard comme page d'accueil (le dashboard actuel reste en
sous-page « Statistiques »). Quatre blocs, AUCUNE liste de mails :
- **🔥 À FAIRE** : réponses attendues (attention.ts), échéances du jour/en
  retard, factures détectées (A1 intent=invoice non traitée), relances dues.
- **🟠 IMPORTANT** : importants high non lus (importance.ts).
- **🟢 PEUT ATTENDRE** : conversations medium, le reste des entrants person.
- **⚪ BRUIT** : compteurs par catégorie (newsletters, notifications, promos)
  avec bouton d'action DIRECTE « Supprimer les N » / « Archiver les N » →
  modale d'aperçu existante (garde-fous inchangés).
Chaque ligne est une PHRASE d'action (« Répondre à Soraya — reçu il y a
2 j »), clic → panneau de lecture existant. Le brief ☀️ s'intègre en tête.

### ✅ A3 — Stratégies de rétention (nettoyage V2) — LIVRÉE

**Livré.** Modèle `RetentionPolicy` (global toutes boîtes, clé de preset
unique, matchIntent/matchCategory (OR si les deux), unseenOnly, ageDays,
action trash, enabled/autoApply, appliedCount) + migration.
`services/retention.ts` : 7 presets livrés DÉSACTIVÉS (otp7, shipping30,
notif90, social90, confirm180, newsletter90 jamais lues, promo30 jamais
lues) — upsert idempotent qui ne touche jamais enabled/autoApply ;
`listPolicies` (simulation SQL count+octets par stratégie) ;
`previewPolicy` (liste exacte cap 500, plus anciens d'abord) ;
`applyPolicy` (dryRun PAR DÉFAUT, exige enabled, corbeille par lots de
200 groupés compte+dossier via imapService.moveToTrash +
reflectBulkInIndex, erreurs par boîte sans arrêt, UNE entrée de journal
par boîte avec liste exacte — pas de journal si échec sans action,
appliedCount incrémenté) ; `updatePolicy` (GARDE-FOU autoApply⇒enabled,
désactivation ⇒ auto retombe, ageDays 1-3650) ; `runAutoRetention` hook
post-sync (sync.ts, non bloquant, scoped au compte, journal
retention_auto_apply). API : GET `/api/retention` (+simulations), GET
`/retention/:id/preview`, POST `/retention/:id/apply` (job
`retention:<id>`, 409 si en cours, 400 si désactivée), PATCH
`/retention/:id`. UI : panneau « 🗂️ Stratégies de rétention » en tête de
`#/cleanup` — toggle par stratégie, badge simulation live, case « auto »
(visible si activée, confirmation explicite), 👀 Aperçu (modale liste
exacte), 🧹 Appliquer (confirm → job suivi par la pastille). Billets/
réservations après événement : reporté (nécessite le croisement dates —
avec A4/A5). Tests : seed-retention.mts (13 asserts) + ui-retention.mjs
(12 checks — job réel avec IMAP indisponible → terminé proprement).
L'utilisateur doit VALIDER EN RÉEL une application (IMAP réel mocké en dev).

Catalogue de règles de nettoyage par catégorie × âge, chacune activable
individuellement, TOUJOURS avec simulation avant exécution :
- OTP/codes > 7 j ; expéditions/livraisons > 30 j ; notifications (GitHub,
  réseaux sociaux…) > 90 j ; confirmations de commande > 6 mois ;
  newsletters jamais ouvertes > 90 j ; promos jamais ouvertes ; billets/
  réservations après la date de l'événement (croise A1 + dates deadlines).
- **Migration** `RetentionPolicy` (catégorie/intention cible, âge, action
  trash|archive, enabled, appliedCount) + presets livrés désactivés.
- Écran « 🧹 Nettoyage » enrichi : chaque stratégie affiche « N mails ·
  X Mo » (simulation index-only), bouton Aperçu → liste exacte → exécution
  par lots journalisée. Exécution possible post-sync pour les stratégies
  cochées « auto » (même garde-fou que L7 : jamais auto sans validation
  préalable de la stratégie).

### ✅ A4 — « Pourquoi ma boîte est pleine ? » + mode Grand ménage — LIVRÉE

**Livré.** `services/report.ts` : `generateMailboxReport()` index-only
instantané (périmètre : non supprimés hors corbeille/spam) — répartition
par catégorie A1 (+ « Toi (envoyés) » et « Non catégorisé », pct),
ancienneté 4 tranches (<1 an, 1-3, 3-5, >5 ans), top expéditeurs par
nombre ET par poids (table Sender), répartition par boîte, et
« récupérable sans risque » = UNION DISTINCTE SQL des cibles des 7
stratégies A3 (pas de double compte) ; `runGrandMenage(policyIds)` —
cocher = valider : active chaque stratégie (persisté) puis l'applique
(mêmes garde-fous A3, erreurs par boîte, rapport par stratégie).
**GARANTIE « 0 mail personnel » ancrée dans le moteur** : policyWhere
(A3) exclut désormais s.category='person' de TOUTES les stratégies —
même une promo transférée par une personne n'est jamais visée (testé).
API : GET `/api/report`, POST `/api/grand-menage` {policyIds} (job
`grand-menage`, 409 si en cours). UI : écran `#/bigclean` (sidebar « 🧺
Grand ménage ») — 3 cartes KPI (mails analysés, espace, récupérable avec
la garantie), barres de répartition par catégorie (CSS bar-track
existant), ancienneté, top poids, bloc de lancement (stratégies à cible
cochées par défaut, badge simulation, 👀 aperçu réutilisé d'A3,
confirmation chiffrée, job suivi par la pastille). Tests :
seed-report.mts (14 asserts dont la garantie personne et l'union) +
ui-bigclean.mjs (13 checks, job réel). Billets après événement :
toujours au backlog (croisement dates).

LA killer feature. Sur une boîte ou toutes :
- **Rapport** (index-only, job) : répartition % par catégorie A1, top
  expéditeurs par volume ET par octets (sizeBytes), ancienneté, « tu peux
  supprimer N mails / récupérer X Go sans risque » (agrégat des stratégies
  A3 + candidats nettoyage existants, mails personnels JAMAIS comptés).
- **Grand ménage** : bouton unique → analyse complète → rapport → simulation
  globale (par stratégie, dépliable) → l'utilisateur coche → exécution par
  lots avec progression (jobs existants) et journal complet. Rappel corbeille
  ~30 j = filet de sécurité.

### ✅ A5 — Relances pilotées + priorité par relation — LIVRÉE

**Livré.** **Escalade** : `FollowupItem.stage` (waiting → due (> seuil) →
urgent (> 2× seuil) → stale (> 30 j)) + stageLabel/suggestion FR calculés
dans followups.ts. Écran ⏰ Relances : badges par étape (🚨 urgent, 💤
probablement abandonné — clôturer ?), bouton « 🗄️ Clôturer » sur les
fils abandonnés (= dismiss existant), bouton « ✍️ Relancer » (dès due) →
modale d'envoi EXISTANTE pré-remplie (destinataire, Re:, brouillon de
relance poli avec date/délai, replyRef fil) — rien ne part sans clic.
Accueil « Aujourd'hui » : badges d'étape + suggestion sur les lignes
relance. **Priorité par relation** : migration `Sender.priority` (normal
| always_important | never_urgent, jamais recalculée — survit à
rebuildSenders) ; scoring importance : ⭐ +40 « ton choix », 🔕 plafond 30
après calcul (raisons explicites) — loadSenderKinds enrichi ;
`setSenderPriority` (categorize.ts) ; PATCH `/accounts/:slug/senders`
accepte category et/ou priority (validations, journaux
ui_sender_category/ui_sender_priority) ; stats expéditeurs exposent
priority ; UI : sélecteur « Priorité » (normale / ⭐ / 🔕) à côté de la
catégorie dans le tableau des expéditeurs. Tests : seed-priority.mts
(13 asserts : 4 étapes, boost/plafond avec raisons, survie au recalcul)
+ ui-priority.mjs (11 checks : badges, brouillon pré-rempli, PATCH réels,
écran Importants boosté). L'utilisateur doit valider EN RÉEL un envoi de
relance (SMTP mocké en dev).

- **Escalade automatique des états** (followups) : à relancer → urgent
  (2e seuil) → probablement abandonné (ex. 30 j) → « Clôturer ? ». L'outil
  propose la relance (brouillon pré-rempli via la modale d'envoi existante)
  et propose la clôture — l'utilisateur clique.
- **Priorité par relation** : `Sender.priority` (always_important /
  never_urgent / normal), réglable d'un clic (vue stats, panneau de
  lecture) ; override du scoring importance (+40 / cap 30) avec raison
  « expéditeur marqué toujours important » ; signal d'apprentissage A6.

### ✅ A6 — Mode Apprentissage (extension de L7) — LIVRÉE

**Livré. LA SÉRIE A (Cap V3) EST COMPLÈTE.** Modèle `SuggestionDismissal`
(kind+refKey uniques : « Ignorer » est mémorisé, jamais reproposé) +
migration. `services/learning.ts` : `listSuggestions()` — 3 familles,
chacune avec sa PREUVE en français : (1) règles de classement = moteur
L7 `suggestRules` existant relancé par compte (idempotent) + règles
`suggested` remontées ; (2) rétention → auto = stratégie ACTIVÉE non-auto
appliquée à la main ≥ 2 fois (comptage journal `retention_apply`/
`grand_menage` par params.policy) ; (3) priorités par relation déduites
du COMPORTEMENT DE LECTURE : ⭐ si ≥ 10 mails TOUS lus
(person/company/non catégorisé), 🔕 si ≥ 20 mails dont ≥ 90 % jamais
ouverts (jamais person) — cap 20 suggestions. `dismissSuggestion(kind,
refKey)` (upsert idempotent, kinds validés). LA VALIDATION passe par les
mécanismes existants (PATCH règle L7 → active, PATCH rétention autoApply,
PATCH sender priority) — aucun nouveau chemin d'écriture. API : GET
`/api/suggestions`, POST `/api/suggestions/dismiss` (journal
ui_suggestion_dismiss). UI : écran `#/suggestions` (sidebar « 💡
Suggestions » + badge total, rafraîchi au boot) — 3 panneaux, phrase +
« Preuve : … » par ligne, ✓ Valider (confirmation pour l'auto) / ✕
Ignorer, suggestion consommée disparaît naturellement (l'état a changé).
Tests : seed-learning.mts (11 asserts) + ui-suggestions.mjs (14 checks,
PATCH réels) + régressions ui-categorize/ui-retention.

Toutes les décisions manuelles deviennent des signaux : le journal
`operations.jsonl` + les corrections A1/A5 sont agrégés par un
`services/learning.ts` (job périodique index-only) qui détecte les
récurrences (« tu as supprimé 12× les notifications GitHub Actions »,
« tu archives toujours Booking », « tu ouvres toujours Club Med ») et crée
des SUGGESTIONS : règles de classement (mécanique L7 existante), stratégies
de rétention A3, priorités A5. Écran « 💡 Suggestions » groupé par type,
avec la preuve (« observé N fois sur 3 semaines ») ; valider = la règle
existe, cocher auto = elle agit. Jamais d'action sans validation.

### Explicitement REPORTÉ (pour ne pas se disperser)

- Extraction PDF des factures + archivage documentaire hors mail (nécessite
  parsing de contenu — 2e temps, Sonnet dédié).
- Fusion des doublons (risqué, valeur faible tant que le bruit domine).
- Détection sémantique fine des intentions dans le CORPS (Sonnet dédié).
- L6 (déploiement Oracle) reste ORTHOGONAL : prêt à exécuter le jour où
  l'utilisateur veut y passer ~45 min — avant ou pendant la série A, au
  choix.

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
