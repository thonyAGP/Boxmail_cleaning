#!/usr/bin/env bash
# =============================================================================
# Installation Boxmail / Mail Assistant sur un serveur Ubuntu (Oracle Cloud) —
# L6. Script IDEMPOTENT : relançable sans casser l'existant.
#
# Usage (en SSH sur l'instance, utilisateur avec sudo) :
#   git clone https://github.com/thonyAGP/Boxmail_cleaning.git boxmail
#   cd boxmail && bash deploy/setup-oracle.sh
#
# Le script :
#   1. installe Node.js 20 LTS, nginx, certbot, pm2 ;
#   2. crée le .env de production (secrets générés automatiquement) ;
#   3. installe les dépendances, prépare la base, compile ;
#   4. démarre l'app sous pm2 (relance auto + au boot) ;
#   5. installe la conf nginx et demande le certificat TLS.
#
# Il DEMANDE : le nom de domaine, le mot de passe admin, un email (certbot).
# Il AFFICHE à la fin : le bearer token à coller dans le connecteur Claude.
#
# Prérequis à faire AVANT (voir docs/DEPLOY-ORACLE.md) :
#   - DNS : un enregistrement A du domaine vers l'IP publique de l'instance ;
#   - OCI : ports 80 et 443 ouverts dans la Security List du subnet.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
say() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m  ✅ %s\033[0m\n' "$*"; }

if [[ $(id -u) -eq 0 ]]; then
  echo "Ne pas lancer en root : utiliser un utilisateur normal avec sudo." >&2
  exit 1
fi

# --- 0. Questions --------------------------------------------------------------
# Les trois réponses peuvent être fournies à l'avance par variables
# d'environnement (BOXMAIL_DOMAIN / BOXMAIL_EMAIL / BOXMAIL_ADMIN_PASSWORD).
# Utile depuis un téléphone : l'installation devient UNE commande, sans
# question à répondre — donc rien à reprendre si la connexion se coupe.
DOMAIN_DEFAULT="boxmail.lb2i.com"
if [[ -n "${BOXMAIL_DOMAIN:-}" ]]; then
  DOMAIN="$BOXMAIL_DOMAIN"
else
  read -rp "Nom de domaine du serveur [${DOMAIN_DEFAULT}] : " DOMAIN
fi
DOMAIN="${DOMAIN:-$DOMAIN_DEFAULT}"

if [[ -n "${BOXMAIL_EMAIL:-}" ]]; then
  CERT_EMAIL="$BOXMAIL_EMAIL"
else
  read -rp "Email pour le certificat TLS (rappels Let's Encrypt) : " CERT_EMAIL
fi

if [[ -f .env ]]; then
  say ".env existant trouvé — il est conservé tel quel."
  ADMIN_PASSWORD=""
else
  if [[ -n "${BOXMAIL_ADMIN_PASSWORD:-}" ]]; then
    ADMIN_PASSWORD="$BOXMAIL_ADMIN_PASSWORD"
  else
    read -rsp "Mot de passe de l'interface web (ADMIN_PASSWORD, FORT) : " ADMIN_PASSWORD
    echo
  fi
  if [[ ${#ADMIN_PASSWORD} -lt 12 ]]; then
    echo "Mot de passe trop court (12 caractères minimum)." >&2
    exit 1
  fi
fi

# --- 1. Paquets ----------------------------------------------------------------
# Les images « Minimal » d'Ubuntu n'embarquent ni curl ni ca-certificates :
# on les installe AVANT de s'en servir pour ajouter le dépôt Node.
say "Préparation du système…"
sudo apt-get update -qq
sudo apt-get install -y -qq curl ca-certificates gnupg openssl

say "Installation des paquets (Node 20, nginx, certbot)…"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y -qq nginx certbot python3-certbot-nginx git
command -v pm2 >/dev/null || sudo npm install -g pm2
ok "node $(node -v), nginx, certbot, pm2"

# --- 2. .env de production -------------------------------------------------------
if [[ ! -f .env ]]; then
  say "Création du .env de production (secrets générés)…"
  BEARER="$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-48)"
  ENC_KEY="$(openssl rand -base64 32)"
  cat > .env <<ENV
PORT=8787
HOST=127.0.0.1
TRUST_PROXY=1
PUBLIC_BASE_URL=https://${DOMAIN}
MCP_BEARER_TOKEN=${BEARER}
TOKEN_ENCRYPTION_KEY=${ENC_KEY}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
MS_CLIENT_ID=00449d9d-90ad-4891-939b-7e55f4d4d816
SYNC_INTERVAL_MINUTES=30
LOG_LEVEL=info
RATE_LIMIT_MAX=120
RATE_LIMIT_WINDOW_MS=60000
ENV
  chmod 600 .env
  ok ".env créé (chmod 600)"
fi

# --- 3. Build -------------------------------------------------------------------
say "Dépendances, base de données, compilation…"
npm install --no-audit --no-fund
npm run db:setup
npm run build
ok "build OK"

# --- 4. pm2 ---------------------------------------------------------------------
say "Démarrage sous pm2 (relance auto)…"
pm2 startOrReload deploy/ecosystem.config.js
pm2 save
# Service systemd au boot (idempotent — pm2 affiche la commande sudo si besoin)
sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null || true
pm2 save
ok "boxmail-mcp sous pm2"

# --- 4b. Pare-feu local ----------------------------------------------------------
# PIÈGE ORACLE : les images Ubuntu d'OCI embarquent des règles iptables qui
# REJETTENT tout sauf SSH. Ouvrir les ports dans la Security List ne suffit
# donc pas — sans ça, Let's Encrypt ne peut pas joindre le port 80 et la
# demande de certificat échoue. On insère les autorisations en TÊTE de chaîne
# (avant la règle de rejet), puis on les rend permanentes.
say "Ouverture des ports 80/443 sur le pare-feu local…"
if command -v iptables >/dev/null; then
  for port in 80 443; do
    if ! sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
      sudo iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
    fi
  done
  if command -v netfilter-persistent >/dev/null; then
    sudo netfilter-persistent save >/dev/null 2>&1 || true
  else
    sudo apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
    sudo netfilter-persistent save >/dev/null 2>&1 || true
  fi
  ok "ports 80/443 autorisés localement (règles rendues permanentes)"
fi
# ufw n'est pas actif par défaut sur ces images, mais si l'utilisateur l'a
# activé un jour, on l'ouvre aussi plutôt que d'échouer sans explication.
if command -v ufw >/dev/null && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
  sudo ufw allow 80/tcp >/dev/null && sudo ufw allow 443/tcp >/dev/null
  ok "ufw : 80/443 autorisés"
fi

# --- 5. nginx + TLS --------------------------------------------------------------
say "Configuration nginx pour ${DOMAIN}…"
sudo tee /etc/nginx/sites-available/boxmail >/dev/null <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # SSE (MCP Streamable HTTP) : pas de buffering, timeouts longs.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        chunked_transfer_encoding on;
    }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/boxmail /etc/nginx/sites-enabled/boxmail
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
ok "nginx actif (HTTP)"

say "Certificat TLS Let's Encrypt (certbot passe la conf en HTTPS + redirection)…"
sudo certbot --nginx -d "${DOMAIN}" -m "${CERT_EMAIL}" --agree-tos --no-eff-email --redirect
# HSTS (certbot ne le pose pas toujours)
if ! sudo grep -q 'Strict-Transport-Security' /etc/nginx/sites-available/boxmail; then
  sudo sed -i '/server_name '"${DOMAIN}"';/a\    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\n    add_header X-Content-Type-Options "nosniff" always;' /etc/nginx/sites-available/boxmail
  sudo nginx -t && sudo systemctl reload nginx
fi
ok "HTTPS actif"

# --- 6. Vérifications + récap -----------------------------------------------------
say "Vérifications…"
sleep 1
curl -fsS "http://127.0.0.1:8787/health" >/dev/null && ok "app : /health répond en local"
curl -fsS "https://${DOMAIN}/health" >/dev/null && ok "nginx : https://${DOMAIN}/health répond"

BEARER_LINE="$(grep '^MCP_BEARER_TOKEN=' .env | cut -d= -f2-)"
cat <<RECAP

=============================================================================
✅ INSTALLATION TERMINÉE — https://${DOMAIN}
=============================================================================
Interface web : https://${DOMAIN}/admin/   (mot de passe ADMIN_PASSWORD)

Reste à faire À LA MAIN (voir docs/DEPLOY-ORACLE.md) :
 1. Entra : ajouter la redirect URI
      https://${DOMAIN}/api/enroll/callback
    (portal.azure.com > boxmail-mcp > Authentification > Mobile & desktop)
 2. Enrôler les boîtes depuis https://${DOMAIN}/admin/ (＋ Ajouter un compte)
 3. Connecteur Claude (claude.ai > Settings > Connectors > Add custom) :
      URL    : https://${DOMAIN}/mcp
      Header : Authorization: Bearer ${BEARER_LINE}

Commandes utiles : pm2 logs boxmail-mcp · pm2 restart boxmail-mcp
=============================================================================
RECAP
