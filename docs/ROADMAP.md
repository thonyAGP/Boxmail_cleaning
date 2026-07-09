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

## ⬜ L4 — Export contacts depuis l'interface

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

## ⬜ L5 — Brief quotidien & revue hebdo (Phase 8)

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

## ⬜ L6 — Déploiement Oracle Cloud + connecteur Cowork

**Objectif.** Serveur accessible en HTTPS pour Claude Cowork ET pour
l'utilisateur (interface), 24/7.

1. **Auto-sync serveur** (pré-requis 24/7) : env `SYNC_INTERVAL_MINUTES`
   (0=off, défaut 30 en prod) — setInterval dans index.ts qui lance un job
   sync-all `recent` si aucun job en cours ; log discret.
2. **Instance** (utilisateur en SSH guidé, ou session Claude sur le serveur) :
   cloner le repo, Node 20+, `.env` prod : PORT=8787, HOST=127.0.0.1,
   PUBLIC_BASE_URL=https://mcp.lb2i.fr, ADMIN_PASSWORD fort, MCP_BEARER_TOKEN
   fort, TOKEN_ENCRYPTION_KEY (NOUVELLE clé), MS_CLIENT_ID identique,
   SYNC_INTERVAL_MINUTES=30. `npm install && npm run db:setup && npm run build`.
3. **pm2** : `pm2 start deploy/ecosystem.config.js && pm2 save && pm2 startup`
   (BOXMAIL_SUPERVISED déjà dans ecosystem) — la mise à jour 1-clic marche
   (branche Linux d'update.ts : install+build in-process puis exit → pm2).
4. **nginx + TLS** : deploy/nginx.conf.example (SSE : proxy_buffering off).
   DNS mcp.lb2i.fr → IP. certbot.
5. **Firewall — DÉCISION ACTÉE À CONFIRMER avec l'utilisateur** : 443 ouvert
   au monde (interface utilisateur nécessite son IP résidentielle variable) ;
   protections : bearer fort sur /mcp, ADMIN_PASSWORD fort + rate limit sur
   /api, HSTS. Alternative stricte : allowlist IP Anthropic + IP box de
   l'utilisateur sur /admin+/api au niveau nginx.
6. **Entra** : ajouter redirect URI `https://mcp.lb2i.fr/api/enroll/callback`
   (plateforme Mobile & desktop).
7. **Comptes** : ré-enrôler les boîtes depuis l'interface distante (2 min/boîte)
   — OU copier accounts.json + réutiliser la même TOKEN_ENCRYPTION_KEY
   (documenter les deux, recommander le ré-enrôlement).
8. **Connecteur Claude** : Settings → Connectors → Add custom connector →
   `https://mcp.lb2i.fr/mcp` + header Authorization Bearer. Tester depuis
   Cowork : list_accounts, get_global_overview, generate_daily_brief.
9. **README** : section déploiement mise à jour pas-à-pas.

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
