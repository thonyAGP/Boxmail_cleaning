# Déployer Mail Assistant sur Oracle Cloud (L6) — guide pas-à-pas

Objectif : ton Mail Assistant accessible **24/7 en HTTPS**, pour toi (interface
web depuis n'importe où) ET pour Claude (connecteur Cowork → l'IA sur ton
forfait). Une seule étape passe par un terminal, et c'est **un copier-coller**
de 3 lignes : le script fait tout le reste.

> ⏱️ Prévois **~45 minutes** + 15-30 min de première synchro (en arrière-plan).
> À faire **sur ton PC Lenovo** (tu auras besoin de la clé SSH et de tes
> navigateurs habituels).

---

## Avant de commencer — la check-list du matériel

- [ ] **Un compte Oracle Cloud** (offre *Always Free*, gratuite à vie) →
      créer sur <https://www.oracle.com/cloud/free/>
- [ ] **La main sur le DNS de ton domaine** (là où est géré `lb2i.fr` : ton
      registrar / bureau d'enregistrement)
- [ ] **L'accès au portail Azure** pour l'app « boxmail-mcp » →
      <https://portal.azure.com>
- [ ] **Ton compte Claude** (Pro/Max) → <https://claude.ai>

> 📌 Dans tout ce guide, remplace `mcp.lb2i.fr` par **le domaine que tu
> veux réellement utiliser** si c'est différent. C'est la même valeur qu'il
> faudra saisir partout (DNS, script, Azure, Claude) — choisis-la maintenant
> et garde-la sous les yeux.

---

## Étape 1 — Créer le serveur Oracle (console web, ~10 min)

Tout à la souris, rien en ligne de commande.

1. Va sur la console : <https://cloud.oracle.com> → menu **Compute →
   Instances → Create instance**.
2. **Image** : Ubuntu (22.04 ou 24.04).
   **Shape** : `VM.Standard.A1.Flex` (Ampere — gratuit à vie, 2 processeurs /
   12 Go, bien plus confortable). À défaut `VM.Standard.E2.1.Micro`.
3. **Réseau** : laisse le VCN/subnet proposés, et surtout **IP publique :
   Oui (Assign a public IPv4 address)**.
4. **Clés SSH** : choisis **« Generate a key pair for me »**, puis
   **⬇️ Download private key**. Range ce fichier `.key` précieusement : c'est
   la clé de la maison (on s'en sert à l'étape 3).
5. Clique **Create**. Attends le statut vert **Running**.
6. **Note l'adresse IP publique** affichée sur la page de l'instance.

### Ouvrir les ports 80 et 443

Console OCI → **Networking → Virtual Cloud Networks → ton VCN → le subnet →
Security Lists → Default Security List → Add Ingress Rules**, et ajoute ces
**deux** règles :

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | **443** |
| `0.0.0.0/0` | TCP | **80** |

> 🔒 **Choix de sécurité acté** : port ouvert au monde, protégé par HTTPS +
> mot de passe fort + limite de tentatives (interface) et token secret
> (partie Claude). Ton IP maison change → tu peux ouvrir l'interface de
> partout. Alternative stricte (liste blanche d'IP) : `deploy/oci-firewall.md`.

---

## Étape 2 — Faire pointer le domaine (DNS)

Chez ton registrar (là où tu gères `lb2i.fr`), crée un enregistrement :

| Type | Nom / Hôte | Valeur | TTL |
|---|---|---|---|
| **A** | **mcp** | **l'IP publique de l'étape 1** | 300 |

(→ ça crée `mcp.lb2i.fr`.) Attends quelques minutes (jusqu'à 1 h selon le
registrar) que ça se propage.

> ✅ **Vérifier que c'est propagé** avant l'étape 3 : ouvre
> <https://dnschecker.org>, tape `mcp.lb2i.fr`, type **A** — l'IP de ton
> instance doit apparaître. C'est important : le certificat HTTPS échoue si
> le domaine ne pointe pas encore vers le serveur.

---

## Étape 3 — Installer (LE copier-coller)

Il faut se connecter au serveur en SSH. **Pas besoin de PowerShell** 😉 —
le plus simple depuis Windows est le terminal intégré à la console Oracle :

### Se connecter — méthode « zéro installation » (Cloud Shell)

1. Dans la console Oracle (en haut à droite), clique l'icône **`>_`
   (Cloud Shell)** : un terminal s'ouvre dans le navigateur.
2. Envoie-y ta clé privée : menu **⋯ → Upload** → choisis le fichier `.key`
   téléchargé à l'étape 1.
3. Dans le terminal, tape (remplace `IP_PUBLIQUE` par ton IP) :

   ```bash
   chmod 600 *.key
   ssh -i *.key ubuntu@IP_PUBLIQUE
   ```

   À la question « Are you sure… (yes/no) », réponds **yes**.

> Alternative si tu préfères un logiciel : **PuTTY**
> (<https://www.putty.org>) — un peu plus long (conversion de la clé avec
> PuTTYgen). Cloud Shell reste le plus simple.

### Coller ces 3 lignes

Une fois connecté (l'invite devient `ubuntu@... :~$`), colle :

```bash
git clone https://github.com/thonyAGP/Boxmail_cleaning.git boxmail
cd boxmail
bash deploy/setup-oracle.sh
```

Le script pose **3 questions** :
1. **Nom de domaine** → `mcp.lb2i.fr`
2. **Email** (rappels du certificat Let's Encrypt) → ton email
3. **Mot de passe de l'interface** (12 caractères minimum) → choisis-en un
   solide et **note-le**

…puis il fait tout seul : Node 20, dépendances, base, compilation, démarrage
sous pm2 (relance auto + au redémarrage du serveur), nginx, certificat HTTPS.

À la fin, il affiche un **récapitulatif à conserver** — copie-le dans un
fichier texte. Il contient notamment le **token secret `MCP_BEARER_TOKEN`**
dont tu auras besoin à l'étape 6.

---

## Étape 4 — Déclarer l'adresse de retour dans Azure/Entra

<https://portal.azure.com> → **App registrations** → **boxmail-mcp** →
**Authentication** → sous « Mobile and desktop applications » →
**Add a platform / Add URI** → colle :

```
https://mcp.lb2i.fr/api/enroll/callback
```

→ **Save**. (Propagation : 2 à 10 minutes, comme la première fois.)

---

## Étape 5 — Enrôler tes boîtes sur le serveur

1. Ouvre **`https://mcp.lb2i.fr/admin/`** et connecte-toi avec le mot de
   passe choisi à l'étape 3.
2. **＋ Ajouter un compte** pour chaque boîte — exactement comme sur ton PC
   (~2 min par boîte : popup Microsoft, sélection du compte, code).
3. Clique **Tout synchroniser** : première indexation ~15-30 min pour tes
   ~46 000 mails (ça tourne en arrière-plan, la pastille d'activité le
   montre). Ensuite la synchro automatique prend le relais toutes les 30 min.

> Pourquoi ré-enrôler plutôt que copier depuis le PC ? C'est plus propre :
> chaque machine a ses propres accès, révocables séparément.

---

## Étape 6 — Brancher Claude (connecteur Cowork)

<https://claude.ai> → **Settings → Connectors → Add custom connector** :

- **URL** : `https://mcp.lb2i.fr/mcp`
- **En-tête / Header** : `Authorization` = `Bearer <MCP_BEARER_TOKEN du récap>`

Puis, dans une conversation Claude, teste :
« **liste mes comptes mail** », « **fais-moi le brief du jour** »,
« **analyse mes mails incertains** ». 🎉 C'est là que l'IA travaille sur tes
vrais mails, décomptée de ton forfait.

---

## Étape 7 (optionnel) — La session IA planifiée « chaque nuit »

Une fois le connecteur en place, tu peux demander à Claude de tourner tout
seul la nuit. Dans Claude (Cowork), ouvre une conversation avec le connecteur
Boxmail et crée une **tâche planifiée** (fonction de programmation de Claude)
avec un message du type :

> « Chaque nuit à 3 h, analyse mes mails incertains (list_uncertain_messages),
> propose-moi les corrections d'expéditeurs avec la raison, et prépare un
> court rapport que je lirai au réveil. Ne corrige rien sans mon accord. »

Au matin, tu retrouves le rapport. (C'est côté Claude que ça se programme :
le serveur, lui, ne fait que préparer les données gratuitement — voir plus
bas « Comment marche l'IA ».)

---

## Et après ?

- **Mises à jour** : le bandeau bleu de l'interface fonctionne aussi sur le
  serveur (pm2 relance tout seul). Tu livres comme d'habitude.
- **Ton PC** : tu peux continuer avec `MailAssistant.bat` en local, ou ne
  plus utiliser que le serveur — les deux ne partagent pas leur index.
- **Logs serveur** (si besoin de diagnostic) : `pm2 logs boxmail-mcp`.

## En cas de pépin

| Symptôme | Piste |
|---|---|
| `https://mcp.lb2i.fr` ne répond pas | DNS pas encore propagé (étape 2, vérifie sur dnschecker.org) ou ports 80/443 pas ouverts (étape 1). |
| Certificat refusé par certbot | Le DNS doit pointer vers l'instance AVANT l'étape 3 — attends la propagation puis relance `bash deploy/setup-oracle.sh` (il est relançable sans risque). |
| AADSTS50011 à l'enrôlement | URI de l'étape 4 mal copiée ou pas encore propagée (attends 10 min). |
| Claude répond « unauthorized » | Le header Bearer du connecteur ne correspond pas au `MCP_BEARER_TOKEN` du récap. |
| L'interface dit « non supervisé » | `pm2 startOrReload deploy/ecosystem.config.js && pm2 save` |

---

## Comment marche l'IA (à garder en tête)

Il y a **trois** choses distinctes, à ne pas confondre :

1. **Le serveur (ton PC aujourd'hui, Oracle demain)** — synchronise et trie
   par **heuristiques** : catégories, confiance, protections, nettoyage.
   C'est **gratuit**, ça tourne 24/7, mais **ce n'est pas de l'IA** : aucune
   clé API, rien à facturer.
2. **Claude connecté au serveur (Cowork, après l'étape 6)** — c'est **là**
   que l'IA lit tes vrais mails et affine les cas incertains. Ça se décompte
   de ton **forfait**, uniquement quand une conversation Claude est ouverte
   (ou une tâche planifiée, étape 7).
3. **Cette conversation de développement** — me sert à **construire l'outil**.
   Elle ne voit que des mails **de test** (fictifs), pas les tiens. Changer
   le modèle ici ne « lance » aucun traitement de tes mails : ça change juste
   qui je suis dans ce chat.

Donc : **pour voir l'IA sur tes vrais mails, il faut l'étape 6** (le serveur
déployé + le connecteur Claude). Avant ça, il n'y a rien à « lancer ».
