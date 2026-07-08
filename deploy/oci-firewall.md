# Firewall OCI — restreindre 443 aux IP Anthropic

Objectif (SPEC §2.6) : sur l'instance Oracle Cloud Always Free, n'autoriser le
port **443** qu'aux plages IP d'Anthropic, tout le reste fermé. Le port de l'app
Node (8787 par défaut) n'est **jamais** exposé — seul nginx (443) l'est, et
nginx écoute en local sur 127.0.0.1.

Il y a **deux** niveaux de filtrage à configurer :

1. **Security List / NSG** (niveau réseau OCI, dans la console)
2. **iptables/firewalld** (niveau OS, sur l'instance) — les images OCI ont des
   règles iptables par défaut qu'il faut aussi ajuster.

---

## 0. Récupérer les plages IP Anthropic

La liste officielle est publiée dans la doc Anthropic (« Anthropic IP addresses »
sur https://docs.claude.com). **La récupérer à jour au moment du déploiement** et
la re-vérifier périodiquement (elle peut changer). Noter les blocs CIDR (IPv4 et
éventuellement IPv6) des IP sortantes de Claude/Cowork.

Dans les exemples ci-dessous, remplacer `AAA.BBB.CCC.0/24` par les vrais blocs.

---

## 1. Security List (console OCI)

VCN > Subnet > Security List > **Ingress Rules**. Créer une règle par bloc CIDR
Anthropic :

| Champ | Valeur |
|---|---|
| Stateless | No |
| Source Type | CIDR |
| Source CIDR | `AAA.BBB.CCC.0/24` (bloc Anthropic) |
| IP Protocol | TCP |
| Destination Port Range | 443 |

Puis **supprimer** toute règle ingress `0.0.0.0/0` sur 443/80 existante.
Conserver l'accès SSH (22) restreint à votre IP d'admin, pas au monde.

> Note : le port 80 n'est utile que pour le renouvellement Let's Encrypt en mode
> HTTP-01. Si vous utilisez DNS-01, laissez 80 fermé. Sinon, ouvrez 80
> temporairement lors du renouvellement, ou utilisez `certbot --preferred-challenges dns`.

---

## 2. iptables sur l'instance (niveau OS)

Les images Oracle Linux/Ubuntu OCI filtrent déjà via iptables. Ajouter les règles
autorisant 443 depuis les blocs Anthropic, avant la règle REJECT par défaut.

```bash
# Pour chaque bloc Anthropic :
sudo iptables -I INPUT -p tcp -s AAA.BBB.CCC.0/24 --dport 443 -m state --state NEW -j ACCEPT

# Vérifier qu'aucune règle n'ouvre 443 au monde :
sudo iptables -L INPUT -n --line-numbers | grep 443

# Persister (Oracle Linux) :
sudo netfilter-persistent save        # Ubuntu/Debian
# ou
sudo service iptables save            # Oracle Linux 7
# ou, OL8+/firewalld : voir section 3
```

## 3. Alternative firewalld (Oracle Linux 8/9)

```bash
# Créer une zone dédiée n'autorisant que https depuis les IP Anthropic
sudo firewall-cmd --permanent --new-zone=anthropic
sudo firewall-cmd --permanent --zone=anthropic --add-source=AAA.BBB.CCC.0/24
sudo firewall-cmd --permanent --zone=anthropic --add-service=https
# Retirer https de la zone public (monde entier)
sudo firewall-cmd --permanent --zone=public --remove-service=https
sudo firewall-cmd --reload
sudo firewall-cmd --get-active-zones
```

---

## 4. Vérification

- Depuis une IP quelconque (non-Anthropic) : `curl https://mcp.lb2i.fr/health`
  doit **timeout / être refusé**.
- Le bearer token reste la deuxième couche : même une IP autorisée sans token
  reçoit 401/403.
- `sudo ss -tlnp | grep 8787` doit montrer l'app en écoute sur **127.0.0.1**
  uniquement, jamais 0.0.0.0.
