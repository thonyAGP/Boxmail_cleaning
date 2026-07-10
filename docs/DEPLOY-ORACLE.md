# Déployer Mail Assistant sur Oracle Cloud (L6) — guide pas-à-pas

Objectif : ton Mail Assistant accessible 24/7 en HTTPS, pour toi (interface
web) ET pour Claude Cowork (connecteur MCP). Une seule grosse étape se fait
en ligne de commande, et c'est **un copier-coller** : le script fait tout.

> **Ce dont tu as besoin avant de commencer :**
> - un compte Oracle Cloud (l'offre Always Free suffit largement) ;
> - la main sur le DNS du domaine (ex. `lb2i.fr` chez ton registrar) ;
> - l'accès au portail Azure (portal.azure.com) pour l'app « boxmail-mcp » ;
> - ~45 minutes.

---

## Étape 1 — Créer l'instance Oracle (console web)

1. Console OCI → **Compute → Instances → Create instance**.
2. Image : **Ubuntu 22.04** (ou 24.04). Shape : `VM.Standard.E2.1.Micro`
   (Always Free) ou mieux `VM.Standard.A1.Flex` (Ampere, aussi Always Free,
   plus confortable : 2 OCPU / 12 Go).
3. Réseau : laisser le VCN/subnet public proposés, **IP publique : oui**.
4. **Clés SSH** : choisir « Generate a key pair », TÉLÉCHARGER la clé privée
   et la ranger précieusement (c'est la clé de la maison).
5. Create. Noter l'**adresse IP publique** de l'instance.

### Ouvrir les ports 80 et 443

Console OCI → Networking → ton VCN → subnet → **Security List** →
**Add Ingress Rules** :

| Source CIDR | Protocole | Port |
|---|---|---|
| `0.0.0.0/0` | TCP | 443 |
| `0.0.0.0/0` | TCP | 80 |

> **Décision sécurité (option retenue)** : le port 443 est ouvert au monde,
> car ton IP résidentielle change et tu dois pouvoir ouvrir l'interface de
> partout. Les protections : HTTPS + mot de passe fort + limite de
> tentatives sur l'interface, et token secret sur la partie Claude.
> Alternative stricte (allowlist d'IP) : voir `deploy/oci-firewall.md`.

## Étape 2 — Pointer le domaine (DNS)

Chez ton registrar (là où est géré `lb2i.fr`), créer un enregistrement :

- Type **A** · Nom **mcp** · Valeur = **l'IP publique de l'instance** · TTL 300.

Attendre quelques minutes (jusqu'à 1 h selon le registrar).

## Étape 3 — Installer (LE copier-coller)

Se connecter en SSH à l'instance (PowerShell interdit 😉 — depuis Windows,
le plus simple est **PuTTY** ou le terminal intégré du site OCI « Cloud
Shell » ; utilisateur `ubuntu`, avec la clé téléchargée) :

```bash
ssh -i chemin/vers/la-cle.key ubuntu@IP_PUBLIQUE
```

Puis coller CES TROIS LIGNES :

```bash
git clone https://github.com/thonyAGP/Boxmail_cleaning.git boxmail
cd boxmail
bash deploy/setup-oracle.sh
```

Le script pose 3 questions (domaine, email pour le certificat, mot de passe
de l'interface) puis fait tout : Node 20, dépendances, base, compilation,
démarrage sous pm2 (relance auto + au boot), nginx, certificat HTTPS.

À la fin, il affiche un **récapitulatif à conserver** avec le token secret
(`MCP_BEARER_TOKEN`) à coller dans Claude à l'étape 6.

## Étape 4 — Déclarer l'adresse de retour dans Entra

[portal.azure.com](https://portal.azure.com) → **App registrations** →
**boxmail-mcp** → **Authentification** → plateforme « Applications de
bureau et mobiles » → **Ajouter un URI** :

```
https://mcp.lb2i.fr/api/enroll/callback
```

Enregistrer. (Propagation : 2 à 10 minutes, comme la première fois.)

## Étape 5 — Enrôler tes boîtes sur le serveur

Ouvre `https://mcp.lb2i.fr/admin/`, connecte-toi avec le mot de passe
choisi à l'étape 3, puis **＋ Ajouter un compte** pour chaque boîte —
exactement comme sur ton PC (2 minutes par boîte).

> Pourquoi ré-enrôler plutôt que copier ? C'est plus propre : chaque machine
> a ses propres accès révocables. (Alternative pour initiés : copier
> `accounts.json` du PC vers le serveur ET réutiliser la même
> `TOKEN_ENCRYPTION_KEY` dans le `.env` — déconseillé.)

Ensuite : **Tout synchroniser** (première indexation ~15-30 min pour
~46 000 mails), et la synchro automatique prend le relais toutes les 30 min.

## Étape 6 — Brancher Claude (connecteur Cowork)

Sur [claude.ai](https://claude.ai) → **Settings → Connectors →
Add custom connector** :

- **URL** : `https://mcp.lb2i.fr/mcp`
- **En-tête** : `Authorization` = `Bearer <MCP_BEARER_TOKEN du récap>`

Test dans une conversation Claude : « liste mes comptes mail », « fais-moi
le brief du jour ». 🎉

## Et après ?

- **Mises à jour** : le bandeau bleu de l'interface fonctionne aussi sur le
  serveur (pm2 relance automatiquement).
- **Ton PC** : tu peux continuer à utiliser MailAssistant.bat en local, ou
  ne plus utiliser que le serveur — les deux ne partagent pas leur index.
- **Logs serveur** (si Claude ou un technicien doit regarder) :
  `pm2 logs boxmail-mcp`.

## En cas de pépin

| Symptôme | Piste |
|---|---|
| `https://mcp.lb2i.fr` ne répond pas | DNS pas propagé (étape 2) ou ports 80/443 pas ouverts (étape 1). |
| Certificat refusé par certbot | Le DNS doit pointer vers l'instance AVANT l'étape 3 — relancer `bash deploy/setup-oracle.sh` (il est relançable). |
| AADSTS50011 à l'enrôlement | URI de l'étape 4 mal copiée ou pas encore propagée (attendre 10 min). |
| Claude répond « unauthorized » | Le header Bearer du connecteur ne correspond pas au `MCP_BEARER_TOKEN` du `.env` serveur. |
| L'interface dit « non supervisé » | L'app ne tourne pas sous pm2 : `pm2 startOrReload deploy/ecosystem.config.js && pm2 save`. |
