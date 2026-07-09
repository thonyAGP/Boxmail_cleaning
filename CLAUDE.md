# Boxmail / Mail Assistant — mémoire projet pour Claude Code

## Ce qu'est ce projet

Assistant email personnel multi-boîtes pour comptes **Outlook.com/Hotmail
personnels** (refusés par le connecteur M365 officiel de Claude). Deux façades
sur les mêmes services :
1. **Serveur MCP distant** (Streamable HTTP, 26 tools) — destiné à Claude
   Cowork après déploiement ;
2. **Interface web** « Mail Assistant » sur `/admin` — utilisée quotidiennement
   par l'utilisateur dès maintenant, en local sur son PC Windows.

Base : **SPEC V2** (« Assistant Exécutif Email ») — vision : brief quotidien,
mails importants, réponses oubliées, relances, échéances, nettoyage, règles.
Décisions actées : SQLite via Prisma (PAS PostgreSQL/Redis/BullMQ),
intelligence = heuristiques serveur + analyse fine par Claude via MCP,
ordre = fondation → interface → intelligence (Phase 4) → déploiement Oracle.

## Utilisateur

- Anthony, francophone, **non technique** : tout doit passer par l'interface,
  zéro ligne de commande (il a explicitement banni PowerShell).
- Lanceur : double-clic sur **`MailAssistant.bat`** (superviseur
  `scripts/supervisor.mjs` : pull → install → db:setup → build → serveur →
  relance auto). `start-boxmail.bat` = ancien lanceur déprécié (corruption
  .bat auto-modifié), ne plus y toucher.
- **Mises à jour : bandeau sur le tableau de bord** → il clique → le serveur
  git pull puis redémarre (sur Windows, install/build sont faits par le
  superviseur après l'arrêt — verrous DLL Prisma). Donc : **commiter et
  pousser après chaque passe fonctionnelle** ; c'est son canal de livraison.
- Boîtes enrôlées : `thony56_gtr` (perso, ~15 700 mails inbox) et `Brimmo`
  (SARL, objectif n°1 du SPEC). Restent à ajouter : colocar, econom, altoen,
  location-brest, jojo56, techni-soft ×2, location-miron.
- Phase 0 validée : IMAP+XOAUTH2 fonctionne pour les comptes perso (2026).
  Nettoyage validé en réel (mails bien dans Éléments supprimés).

## Architecture (src/)

- `index.ts` — Express : `/mcp` (bearer), `/api` (admin, session cookie),
  `/admin` (statique `web/`), `/health`
- `mcp/tools/*` — 26 tools MCP (accounts, folders, read, write, sync, export,
  attention : réponses/relances/importance)
- `server/admin.ts` — API REST de l'interface (login, overview, stats,
  cleanup preview/messages/execute, sync jobs, enroll popup+code, version,
  update, jobs, operations)
- `services/` — logique partagée MCP/interface :
  - `imap.ts` (pool imapflow XOAUTH2 ; IMPORTANT : plages `a:b` ou `1:*`,
    jamais de longues listes d'UIDs — limite de commande Outlook)
  - `sync.ts` (sync incrémentale IMAP→SQLite : UIDVALIDITY, réconciliation
    suppressions, threads via In-Reply-To puis sujet normalisé, agrégats
    senders ; erreurs par dossier sans arrêter)
  - `cleanup.ts` (candidats + classification par mail auto/personnel :
    perso si répondu/suivi/conversation avec sortant/« Re: »/aucun marqueur ;
    exécution par lots de 200 avec UIDs revalidés côté serveur)
  - `accounts.ts` (accounts.json chiffré AES-256-GCM), `oauth.ts` (MSAL :
    device code + auth code PKCE `prompt=select_account`), `jobs.ts` (tâches
    asynchrones + meta), `oplog.ts` (journal JSONL avec items sujet+date),
    `index-stats.ts`, `update.ts` (version/check/apply, BOXMAIL_SUPERVISED)
- `prisma/schema.prisma` — Account, Folder, Message, Thread, Sender (SQLite,
  `connection_limit=1` forcé dans `db/client.ts`)
- `web/` — SPA vanilla (AUCUN framework/build) : `js/app.js` (routing hash,
  dashboard, vue compte, modales nettoyage/enrôlement, watcher global des
  jobs avec chip d'activité), `js/api.js`, `styles.css`
- CLIs de secours : enroll (+ --rename/--remove), sync, check, stats

## Garde-fous NON NÉGOCIABLES

Soft delete uniquement (corbeille, jamais EXPUNGE) ; dry-run/aperçu par
défaut ; confirmation explicite ; lots de 200 ; tout journalisé dans
`logs/operations.jsonl` avec la liste exacte des mails (items) ; aucun
secret dans les logs/le repo (.env, accounts.json, data/ gitignorés) ;
les tokens ne transitent JAMAIS par Claude ni par le navigateur.

## Conventions de travail

- Branche : `claude/new-session-gutt6f` — commits en français, descriptifs,
  pousser après chaque passe (canal de livraison de l'utilisateur).
- Interface en français, ton tutoiement.
- Tester avant de pousser : `npx tsc --noEmit`, `node --check web/js/*.js`,
  seeds synthétiques (voir scripts de session précédente : seed via Prisma +
  linkThreads/rebuildSenders), serveur sur PORT=8799 en test local, captures
  navigateur via playwright-core + `/opt/pw-browsers/chromium-*/chrome-linux/chrome`.
- `.env` de test à créer (MCP_BEARER_TOKEN, TOKEN_ENCRYPTION_KEY=32 octets
  base64 via `npm run genkey`, MS_CLIENT_ID factice, PORT=8799, LOG_LEVEL=error).
- Pas d'IMAP réel accessible depuis l'environnement de dev Claude : tester
  la logique DB/API/UI avec des seeds, l'utilisateur valide l'IMAP en réel.
- Client ID Entra réel de l'utilisateur : `00449d9d-90ad-4891-939b-7e55f4d4d816`
  (public, app « boxmail-mcp », comptes perso uniquement, flux publics activés,
  redirect URI `http://localhost:8787/api/enroll/callback` déclarée).

## État (fin de session précédente)

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

**Suivre `docs/ROADMAP.md`** : plans d'implémentation détaillés de toutes les
livraisons restantes (L2 Échéances → L3 Recherche → L4 Export contacts →
L5 Briefs → L6 Déploiement Oracle/Cowork + backlog).
Une livraison par session ; lire CLAUDE.md + la livraison visée uniquement ;
à la fin, cocher dans ROADMAP.md et mettre à jour l'« État » ci-dessus.
