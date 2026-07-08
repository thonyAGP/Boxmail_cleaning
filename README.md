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

# 3. Lister ses dossiers de bout en bout via l'Inspector (§7) OU via le serveur
npm run build && npm start        # dans un terminal
# puis appeler le tool list_folders (Inspector, §7)
```

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

> Si Exchange Online n'apparaît pas dans les APIs, utiliser les scopes complets
> `https://outlook.office.com/IMAP.AccessAsUser.All` et
> `https://outlook.office.com/SMTP.Send` (déjà les valeurs par défaut du code).

---

## 5. Enrôlement d'un compte

Se fait **en SSH sur le serveur**, jamais via Claude.

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

---

## 6. Lancer le serveur

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

Sur l'instance Always Free (celle de `hub.lb2i.fr`) :

1. **DNS** : créer `mcp.lb2i.fr` → IP publique de l'instance.
2. **App** : `git clone` + `npm install` + `npm run build` + remplir `.env`.
3. **Enrôler** les comptes (`npm run enroll -- --account brimmo`).
4. **pm2** :
   ```bash
   npm i -g pm2
   pm2 start deploy/ecosystem.config.js
   pm2 save && pm2 startup      # démarrage auto au boot
   ```
5. **TLS + reverse proxy** : adapter [`deploy/nginx.conf.example`](deploy/nginx.conf.example),
   obtenir le certificat (certbot), recharger nginx.
6. **Firewall** : suivre [`deploy/oci-firewall.md`](deploy/oci-firewall.md) pour
   n'ouvrir 443 qu'aux **IP Anthropic** (Security List OCI **et** iptables/firewalld).
7. Vérifier : `curl https://mcp.lb2i.fr/health` depuis une IP autorisée.

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
  ecosystem.config.js   pm2
  oci-firewall.md
.env.example
```
