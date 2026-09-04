# Boxmail MCP — serveur MCP email (IMAP/SMTP OAuth2) pour Claude Cowork

Serveur MCP **distant** (Streamable HTTP) permettant à **Claude Cowork** de trier,
nettoyer et organiser des boîtes **Outlook.com / Hotmail personnelles** — celles
que le connecteur Microsoft 365 officiel refuse (« You can't sign in here with a
personal account »).

Accès mail via **IMAP + XOAUTH2** (OAuth2 Microsoft), multi-comptes dès la v1.
Aucun identifiant/token ne transite par Claude : les refresh tokens sont chiffrés
côté serveur (AES-256-GCM).

> ⚠️ **Phase 0 obligatoire avant tout.** Microsoft a plusieurs fois restreint
> l'accès IMAP OAuth2 des comptes personnels. **Vérifiez d'abord que ça marche
> encore** (voir [§2](#2-phase-0--vérification-bloquante)). Si non, basculez sur
> le [Plan B (Graph API)](#plan-b--si-imap-oauth2-est-mort).

---

## Sommaire

1. [Ce que fait le serveur (tools MCP)](#1-tools-mcp-exposés)
2. [Phase 0 — vérification bloquante](#2-phase-0--vérification-bloquante)
3. [Installation](#3-installation)
4. [App registration Microsoft (Entra)](#4-app-registration-microsoft-entra)
5. [Enrôlement d'un compte](#5-enrôlement-dun-compte)
6. [Lancer le serveur](#6-lancer-le-serveur)
7. [Tester avec MCP Inspector](#7-tester-avec-mcp-inspector)
8. [Déploiement Oracle Cloud (nginx, TLS, firewall, pm2)](#8-déploiement-oracle-cloud)
9. [Ajout du connecteur dans Claude](#9-ajout-du-connecteur-dans-claude)
10. [Ajouter une nouvelle boîte](#10-ajouter-une-nouvelle-boîte)
11. [Garde-fous sur les suppressions](#11-garde-fous-sur-les-suppressions)
12. [Sécurité — checklist](#12-sécurité--checklist)
13. [Plan B — si IMAP OAuth2 est mort](#plan-b--si-imap-oauth2-est-mort)

---

## 1. Tools MCP exposés

Tous les tools acceptent un paramètre optionnel `account` (ex. `"brimmo"`). Si un
seul compte est enrôlé, il est utilisé par défaut.

### Lecture (sans risque)
| Tool | Rôle |
|---|---|
| `list_accounts` | Comptes enrôlés + état du token (jamais le token lui-même) |
| `list_folders` | Arborescence des dossiers IMAP |
| `get_sender_stats` | **Tool clé.** Agrégation par expéditeur : volume, date du + récent, taille, % de mails avec `List-Unsubscribe` (= newsletter/notif). Trié par volume décroissant. |
| `search_emails` | Recherche (from, subject, since/before, seen/unseen). Métadonnées seulement. |
| `read_email` | Corps d'un mail par UID (texte, HTML converti/tronqué ~5000 chars, pièces jointes listées) |
| `get_thread` | Mails d'un même fil (par sujet normalisé) |

### Écriture (protégées)
| Tool | Rôle |
|---|---|
| `create_folder` | Créer un dossier IMAP |
| `move_emails` | Déplacer des UIDs vers un dossier |
| `mark_emails` | Flags seen/unseen/flagged |
| `delete_emails` | Supprimer des UIDs — **dry-run par défaut**, soft delete (corbeille) |
| `bulk_delete_by_sender` | Supprimer tous les mails d'un expéditeur — **dry-run par défaut**, soft delete |

### Index & vues d'ensemble (Phase 3 — SPEC V2)
| Tool | Rôle |
|---|---|
| `sync_account` | Synchronise l'index local SQLite (métadonnées uniquement, jamais les corps). Mode `recent` (INBOX + Envoyés) ou `full` (tous dossiers + flags) |
| `get_mailbox_overview` | Vue d'ensemble d'un compte depuis l'index : INBOX (total, non lus, newsletters, taille), dossiers, top expéditeurs — instantané |
| `get_global_overview` | Vue consolidée de toutes les boîtes indexées + totaux |

> `get_sender_stats` utilise automatiquement l'index quand le dossier est
> synchronisé (résultat instantané, champ `source: "index"`), sinon il retombe
> sur un scan IMAP live (`source: "imap-live"`, lent sur les grosses boîtes).

### Export
| Tool | Rôle |
|---|---|
| `export_senders_vcard` | Génère un `.vcf` (vCard 3.0) et/ou CSV Outlook des expéditeurs fournis, à importer manuellement dans Outlook.com Contacts (non accessibles via IMAP) |

> Envoi de mails (`send_email`) : **hors scope v1**, derrière le flag
> `ENABLE_SMTP_SEND=false`. Désinscription auto aux newsletters : v2.

---

## 2. Phase 0 — vérification bloquante

**Ne rien déployer avant que ce test passe.** Il confirme qu'un compte Microsoft
**personnel** peut encore ouvrir IMAP en XOAUTH2 en 2026.

```bash
# 1. Prérequis : app registration créée (§4) + .env rempli (§3)
# 2. Enrôler un compte de test (device code flow)
npm run enroll -- --account test

# 3. Diagnostic Phase 0 en une commande : connexion IMAP XOAUTH2 + LIST dossiers
npm run check -- --account test
```

La commande `check` affiche l'arborescence des dossiers et le nombre de messages
de l'INBOX. Elle constitue le **test bloquant** : si elle réussit, IMAP+XOAUTH2
est viable. (On peut aussi valider via l'Inspector, cf. §7.)

- ✅ **`list_folders` renvoie l'arborescence** → IMAP+XOAUTH2 fonctionne, on
  continue avec ce backend.
- ❌ **Échec d'authentification IMAP** (`AUTHENTICATIONFAILED`, `LOGIN failed`,
  scope refusé…) → IMAP OAuth2 est probablement bloqué pour les comptes perso.
  Basculer sur le [Plan B](#plan-b--si-imap-oauth2-est-mort).

Détail des symptômes d'échec et pistes dans le [Plan B](#plan-b--si-imap-oauth2-est-mort).

---

## 3. Installation

Prérequis : **Node.js 20+** (testé sur Node 22).

```bash
git clone <repo> boxmail-mcp && cd boxmail-mcp
npm install
npm run db:setup          # crée data/boxmail.db (index local) + client Prisma
cp .env.example .env
```

Générer les deux secrets et les coller dans `.env` :

```bash
npm run genkey   # -> MCP_BEARER_TOKEN (relancer pour TOKEN_ENCRYPTION_KEY)
npm run genkey   # -> TOKEN_ENCRYPTION_KEY
```

Éditer `.env` :

```ini
MCP_BEARER_TOKEN=<1er genkey>          # token à coller dans Claude
TOKEN_ENCRYPTION_KEY=<2e genkey>       # chiffre accounts.json (ne pas perdre)
MS_CLIENT_ID=<client id de l'app>      # voir §4
MS_AUTHORITY=https://login.microsoftonline.com/consumers
PORT=8787
HOST=127.0.0.1
```

> `.env` et `accounts.json` sont dans `.gitignore` : **ne jamais les committer**.
> Si `TOKEN_ENCRYPTION_KEY` est perdue, `accounts.json` devient illisible → il
> faut ré-enrôler les comptes.

---

## 4. App registration Microsoft (Entra)

Sur [https://entra.microsoft.com](https://entra.microsoft.com) →
**App registrations** → **New registration** :

- **Name** : `boxmail-mcp` (libre)
- **Supported account types** : *Personal Microsoft accounts only* (ou
  *Accounts in any org directory and personal Microsoft accounts*)
- **Redirect URI** : aucun (device code flow = client public, pas de redirect)

Après création :

1. **Authentication** → activer **Allow public client flows** = **Yes**
   (indispensable pour le device code flow).
2. **API permissions** → **Add a permission** → *APIs my organization uses* →
   chercher **Office 365 Exchange Online** → **Delegated permissions** →
   ajouter `IMAP.AccessAsUser.All` et `SMTP.Send`.
   (Le scope `offline_access` est demandé automatiquement par MSAL pour obtenir
   le refresh token — ne pas l'ajouter manuellement.)
3. Copier l'**Application (client) ID** → `MS_CLIENT_ID` dans `.env`.
4. **Pour l'enrôlement en un clic depuis l'interface web** (recommandé) :
   **Authentication** → **Add a platform** → **Mobile and desktop applications**
   → cocher/ajouter l'URI de redirection personnalisée :
   `http://localhost:8787/api/enroll/callback`
   (au déploiement, ajouter aussi `https://mcp.lb2i.fr/api/enroll/callback`).
   Sans cette étape, la fenêtre Microsoft affichera l'erreur AADSTS50011 —
   la méthode alternative « par code » reste utilisable.

> Si Exchange Online n'apparaît pas dans les APIs, utiliser les scopes complets
> `https://outlook.office.com/IMAP.AccessAsUser.All` et
> `https://outlook.office.com/SMTP.Send` (déjà les valeurs par défaut du code).

---

## 5. Enrôlement d'un compte

Deux méthodes (jamais via Claude) :

**A. Depuis l'interface web (recommandé)** : bouton **« ＋ Ajouter un compte »**
→ donner un nom court → **une fenêtre Microsoft s'ouvre avec le choix du
compte** (« Utiliser un autre compte » pour une boîte non connectée) → sync
proposée immédiatement. Le sélecteur de compte est forcé (`prompt=select_account`),
donc pas de piège de session déjà ouverte. Prérequis : l'URI de redirection
déclarée dans Entra (§4 point 4). Une méthode alternative « par code »
(device flow) reste disponible dans la même fenêtre. Le mot de passe et le
token ne transitent jamais par la page (tout reste côté serveur, chiffré).

**B. En ligne de commande (SSH)** :

```bash
npm run enroll -- --account brimmo
```

1. Le CLI affiche une **URL** (`microsoft.com/devicelogin`) et un **code**.
2. Sur un navigateur, aller à l'URL, saisir le code, **se connecter avec le
   compte Hotmail/Outlook cible** (ex. Brimmo), accepter les permissions.
3. Le refresh token est chiffré (AES-256-GCM) et stocké dans `accounts.json`.

Vérifier :

```bash
npm run enroll -- --list
```

Gestion des comptes :

```bash
npm run enroll -- --rename ancien --to nouveau   # renommer (token conservé)
npm run enroll -- --remove nom                   # supprimer (token effacé)
```

> Après un renommage, l'index local de l'ancien nom est purgé : relancer
> `npm run sync -- --account <nouveau> --full` pour réindexer.

---

## 6. Lancer le serveur

### Windows — lancement en un double-clic (recommandé)

Double-cliquer sur **`MailAssistant.bat`** (à la racine du projet) : il récupère
les mises à jour, installe, compile, démarre le serveur **et le relance
automatiquement** s'il s'arrête (ex. après une mise à jour depuis l'interface).

- Créer un raccourci du `.bat` sur le Bureau pour un accès direct.
- (`start-boxmail.bat`, l'ancien lanceur, a été SUPPRIMÉ le 04/09 : il pouvait
  se corrompre quand une mise à jour le modifiait en cours d'exécution. Si un
  raccourci pointe encore dessus, le refaire vers `MailAssistant.bat`.)
- Démarrage automatique avec Windows : `Win+R` → `shell:startup` → glisser le
  raccourci dans le dossier qui s'ouvre.
- **Mises à jour** : un bandeau apparaît sur le tableau de bord quand une mise à
  jour est disponible → bouton « Mettre à jour maintenant » → le serveur se met
  à jour et redémarre tout seul, la page revient automatiquement. Plus besoin
  de `git pull` ni de terminal.

### Ligne de commande (toutes plateformes)

```bash
npm run build
npm start
# -> boxmail-mcp démarré sur 127.0.0.1:8787
curl -s http://127.0.0.1:8787/health   # {"status":"ok",...}
```

En dev : `npm run dev` (rechargement à chaud via tsx).

---

## 7. Tester avec MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Dans l'Inspector (ouvre une UI web) :

- **Transport Type** : `Streamable HTTP`
- **URL** : `http://127.0.0.1:8787/mcp`
- **Authentication** : header `Authorization` = `Bearer <MCP_BEARER_TOKEN>`
- **Connect**, puis onglet **Tools** → **List Tools** (12 tools attendus).

Scénarios de test manuels :

| # | Tool | Arguments | Attendu |
|---|---|---|---|
| 1 | `list_accounts` | `{}` | Le/les comptes enrôlés, `tokenOk: true` |
| 2 | `list_folders` | `{}` | Arborescence IMAP (**valide la Phase 0**) |
| 3 | `get_sender_stats` | `{ "folder": "INBOX", "limit": 30 }` | Top expéditeurs + `unsubscribePct` |
| 4 | `search_emails` | `{ "from": "newsletter", "limit": 10 }` | Métadonnées |
| 5 | `read_email` | `{ "uid": <uid vu en 4> }` | Corps texte + pièces jointes |
| 6 | `bulk_delete_by_sender` | `{ "sender": "news@x.com" }` | **dry-run** : liste ce qui serait supprimé, ne touche rien |
| 7 | `bulk_delete_by_sender` | `{ "sender": "news@x.com", "confirm": true }` | Déplace en corbeille, `deleted: N` |
| 8 | `export_senders_vcard` | `{ "senders": [{"address":"a@b.com","name":"A"}] }` | Contenu `.vcf` |

Vérifier ensuite `logs/operations.jsonl` : chaque écriture y est journalisée.

---

## 8. Déploiement Oracle Cloud

**Guide complet pas-à-pas (recommandé) :
[`docs/DEPLOY-ORACLE.md`](docs/DEPLOY-ORACLE.md)** — instance, DNS,
installation en une commande, Entra, enrôlement, connecteur Claude.

En résumé, sur une instance Ubuntu Always Free :

1. **OCI** : ouvrir 80/443 dans la Security List ; **DNS** :
   `mcp.lb2i.fr` → IP publique.
2. **Installation en une commande** (fait tout : Node 20, `.env` prod avec
   secrets générés, build, pm2, nginx, certificat TLS, HSTS) :
   ```bash
   git clone https://github.com/thonyAGP/Boxmail_cleaning.git boxmail
   cd boxmail && bash deploy/setup-oracle.sh
   ```
   Modèle de `.env` prod commenté : [`deploy/env.production.example`](deploy/env.production.example)
   (`TRUST_PROXY=1` derrière nginx, `SYNC_INTERVAL_MINUTES=30`,
   `PUBLIC_BASE_URL` en https → cookie de session `Secure`).
3. **Entra** : ajouter la redirect URI `https://mcp.lb2i.fr/api/enroll/callback`.
4. **Enrôler** les boîtes depuis `https://mcp.lb2i.fr/admin/` (ou CLI).
5. **Firewall strict (optionnel)** : [`deploy/oci-firewall.md`](deploy/oci-firewall.md)
   pour n'ouvrir 443 qu'aux IP Anthropic — au prix de l'accès interface
   depuis une IP résidentielle variable.
6. Vérifier : `curl https://mcp.lb2i.fr/health`.

L'app écoute sur `127.0.0.1:8787` uniquement ; seul nginx est exposé.

---

## 9. Ajout du connecteur dans Claude

Dans Claude : **Settings → Connectors → Add custom connector** :

- **Name** : `Boxmail`
- **URL** : `https://mcp.lb2i.fr/mcp`
- **Advanced settings → Authentication** : ajouter le header
  `Authorization` = `Bearer <MCP_BEARER_TOKEN>` (la valeur de `.env`).

Enregistrer, puis dans une session **Cowork**, activer le connecteur Boxmail et
demander par ex. : *« Donne-moi les statistiques par expéditeur de la boîte
brimmo et repère les newsletters »*.

Réf. connecteurs distants : https://support.claude.com/en/articles/11175166

---

## 10. Ajouter une nouvelle boîte

Trois commandes (SPEC §7.4) :

```bash
npm run enroll -- --account colocar     # 1. device code flow pour la nouvelle boîte
npm run enroll -- --list                # 2. vérifier qu'elle apparaît
pm2 restart boxmail-mcp                  # 3. (optionnel) recharger — pas nécessaire,
                                         #    accounts.json est relu à chaque appel
```

Ensuite dans Claude, passer `"account": "colocar"` aux tools (ou laisser vide si
c'est le seul compte). Boîtes prévues : `colocar`, `econom`, `altoen`,
`location_brest`, `jojo56`, `thony56_gtr`, `technisoft1`, `technisoft2`,
`location_miron`.

---

## 11. Garde-fous sur les suppressions

Non négociables (SPEC §6), implémentés dans `src/mcp/tools/write.ts` :

1. **Dry-run par défaut** : `delete_emails` / `bulk_delete_by_sender` ont
   `confirm` (défaut `false`). Sans `confirm:true` → retourne la liste exacte de
   ce qui **serait** supprimé (count, expéditeurs, sujets, plage de dates), sans
   rien toucher.
2. **Soft delete** : « supprimer » = déplacer vers la corbeille IMAP
   (`\Trash`, récupérable ~30 j côté Outlook.com). **Jamais d'EXPUNGE** en v1.
3. **Plafond 200/appel** : au-delà, le tool refuse et demande de découper.
4. **Journal** : chaque écriture est loggée en JSONL dans `logs/operations.jsonl`
   (timestamp, account, tool, params, UIDs), sans aucun secret.

---

## 12. Sécurité — checklist

- [x] Endpoint `/mcp` derrière **bearer token** fort (32+ octets), comparaison à
      temps constant.
- [x] Refresh tokens **chiffrés AES-256-GCM** au repos (clé hors du repo).
- [x] `.env` et `accounts.json` dans `.gitignore`.
- [x] Aucun secret dans les logs (masquage dans `operations.jsonl` et logger).
- [x] **Rate limiting** par IP sur `/mcp` (60 req/min par défaut).
- [x] App en écoute sur `127.0.0.1` ; TLS + HSTS assurés par le reverse proxy.
- [ ] **Firewall OCI restreint aux IP Anthropic** — à configurer au déploiement
      ([`deploy/oci-firewall.md`](deploy/oci-firewall.md)).
- [ ] **HTTPS + HSTS** via nginx — à configurer au déploiement
      ([`deploy/nginx.conf.example`](deploy/nginx.conf.example)).

---

## Plan B — si IMAP OAuth2 est mort

Si la [Phase 0](#2-phase-0--vérification-bloquante) échoue (Microsoft ayant
encore restreint l'IMAP des comptes perso), pivoter dans cet ordre :

1. **Microsoft Graph API (compte personnel)** — à tester **avant** le Plan C.
   App registration « personal accounts » avec scopes délégués `Mail.ReadWrite`,
   backend `https://graph.microsoft.com/v1.0/me/messages` au lieu d'IMAP. Les
   **mêmes tools MCP** sont conservés ; seule la couche `services/imap.ts` est
   remplacée par un `services/graph.ts`. Bonus : `Contacts.ReadWrite` débloque
   l'ajout **direct** au carnet d'adresses (plus besoin de l'export vCard manuel).
2. **Plan C — forward vers Gmail** : transfert auto de chaque boîte Hotmail vers
   un Gmail dédié, et Cowork travaille via le connecteur Gmail natif. Perte : le
   nettoyage ne s'applique pas à la boîte d'origine.

L'architecture (AccountManager, tools MCP, garde-fous) est backend-agnostique :
le pivot vers Graph ne touche ni la couche MCP ni les garde-fous.

---

## Interface web d'administration

Une interface graphique (« Mail Assistant ») est servie par le même serveur sur
**`http://<hôte>:<port>/admin`** : tableau de bord multi-boîtes, statistiques
par expéditeur (triables, instantanées via l'index), nettoyage conseillé,
synchronisation en un clic avec progression, journal d'activité.

Activation :

1. Ajouter dans `.env` : `ADMIN_PASSWORD=<mot de passe fort>` (ex. `npm run genkey`)
2. `npm start` puis ouvrir `http://localhost:8787/admin`

Sécurité : session cookie httpOnly SameSite=Strict, login à comparaison en
temps constant limité à 10 tentatives/15 min/IP, mêmes services et mêmes
garde-fous que les tools MCP, tout est journalisé dans `operations.jsonl`.
Sans `ADMIN_PASSWORD`, l'interface est désactivée (le MCP fonctionne normalement).

L'interface inclut le **nettoyage guidé** : bouton « Nettoyer » sur chaque
expéditeur candidat → aperçu détaillé (nombre, taille, dates, derniers sujets)
→ confirmation explicite → déplacement vers la corbeille **par lots de 200**
avec progression en direct. Soft delete uniquement (récupérable ~30 jours),
chaque lot journalisé, index mis à jour immédiatement.

L'**enrôlement d'une nouvelle boîte** se fait aussi depuis l'interface
(« ＋ Ajouter un compte ») : le code Microsoft s'affiche dans la page,
plus besoin de terminal.

> Prochaines passes : recherche/lecture de mails, export contacts,
> puis Phase 4 (intelligence : importants, réponses oubliées, échéances).

## Index local des mails (Phase 3 — SPEC V2)

Le serveur maintient un **index SQLite** (`data/boxmail.db`) des métadonnées de
mails : expéditeur, sujet, dates, flags, taille, header List-Unsubscribe, fils
de discussion, agrégats par expéditeur. **Jamais les corps de mails, jamais de
secrets** — les tokens restent dans `accounts.json` chiffré.

```bash
npm run db:setup                       # une fois : crée la base + migrations
npm run sync -- --account brimmo       # sync rapide (INBOX + Envoyés)
npm run sync -- --account brimmo --full  # tous les dossiers + flags lu/non lu
```

Bénéfices :
- `get_sender_stats` passe de ~2 min (scan IMAP) à **instantané** ;
- `get_mailbox_overview` / `get_global_overview` : vision multi-boîtes immédiate ;
- fondation des fonctions V2 (réponses oubliées, relances, échéances, briefs).

La sync est **incrémentale** (seuls les nouveaux mails sont lus, via UID) et
**réconcilie les suppressions** (mails disparus marqués `isDeleted`). Un
changement d'`UIDVALIDITY` déclenche la réindexation propre du dossier.

## Structure du repo

```
src/
  index.ts              bootstrap HTTP + MCP (Streamable HTTP, bearer, rate limit)
  config.ts             configuration (.env)
  logger.ts             logs JSON sur stderr (sans secrets)
  mcp/
    server.ts           assemble le McpServer + enregistre les tools
    util.ts             helpers de résultats/erreurs
    tools/
      accounts.ts       list_accounts
      folders.ts        list_folders, create_folder
      read.ts           get_sender_stats, search_emails, read_email, get_thread
      write.ts          move_emails, mark_emails, delete_emails, bulk_delete_by_sender
      export.ts         export_senders_vcard
  services/
    imap.ts             pool imapflow + opérations IMAP (XOAUTH2)
    smtp.ts             nodemailer (désactivé par défaut)
    accounts.ts         store multi-comptes chiffré + résolution
    oauth.ts            MSAL device code flow + refresh silencieux
    crypto.ts           AES-256-GCM
    oplog.ts            journal JSONL des écritures
    export.ts           génération vCard / CSV
  cli/
    enroll.ts           CLI d'enrôlement (device code flow)
deploy/
  nginx.conf.example
  ecosystem.config.cjs   pm2
  oci-firewall.md
.env.example
```
