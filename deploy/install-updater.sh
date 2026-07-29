#!/usr/bin/env bash
# Installe le minuteur systemd qui met à jour Boxmail depuis L'EXTÉRIEUR de
# l'application. À lancer UNE FOIS, avec sudo, depuis la racine du dépôt :
#
#   sudo bash deploy/install-updater.sh
#
# Après ça, plus aucune intervention manuelle : le minuteur passe chaque nuit,
# récupère la dernière version du script de mise à jour, l'exécute, et revient
# en arrière tout seul si quelque chose casse (voir deploy/update.sh).
# Il désactive aussi la mise à jour interne à l'application, pour qu'il n'y ait
# qu'UN seul mécanisme responsable.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# L'utilisateur propriétaire du dépôt : c'est lui qui a le droit git, npm et
# pm2. Lancer la mise à jour en root casserait les permissions de node_modules.
OWNER="$(stat -c '%U' "$ROOT")"
# pm2 range son état dans $HOME/.pm2 : sans HOME, `pm2 restart` depuis systemd
# ne trouverait pas le process et la mise à jour finirait sans redémarrage.
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
HOUR="${BOXMAIL_UPDATE_HOUR:-04}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Ce script a besoin de sudo (il écrit dans /etc/systemd/system)." >&2
  exit 1
fi

echo "Dépôt      : $ROOT"
echo "Utilisateur: $OWNER"
echo "Passage    : chaque nuit à ${HOUR}h (heure du serveur)"

chmod +x "$ROOT/deploy/update.sh" "$ROOT/deploy/update-boot.sh"

cat > /etc/systemd/system/boxmail-update.service <<EOF
[Unit]
Description=Mise a jour de Boxmail (depuis l'exterieur de l'application)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$OWNER
WorkingDirectory=$ROOT
# PATH explicite : systemd ne charge pas le profil de l'utilisateur, donc ni
# node, ni npm, ni pm2 ne seraient trouves sans ca.
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$ROOT/node_modules/.bin
Environment=HOME=$OWNER_HOME
Environment=PM2_HOME=$OWNER_HOME/.pm2
ExecStart=/usr/bin/env bash $ROOT/deploy/update-boot.sh
TimeoutStartSec=1800
EOF

cat > /etc/systemd/system/boxmail-update.timer <<EOF
[Unit]
Description=Passage nocturne de mise a jour de Boxmail

[Timer]
OnCalendar=*-*-* ${HOUR}:00:00
# Rattrape le passage si le serveur etait eteint a l'heure dite.
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now boxmail-update.timer

# Un seul mécanisme responsable : on éteint la mise à jour interne à l'app.
ENV_FILE="$ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  if grep -q '^AUTO_UPDATE_HOUR=' "$ENV_FILE"; then
    sed -i 's/^AUTO_UPDATE_HOUR=.*/AUTO_UPDATE_HOUR=-1/' "$ENV_FILE"
  else
    printf '\n# Mise à jour gérée par le minuteur systemd (deploy/install-updater.sh)\nAUTO_UPDATE_HOUR=-1\n' >> "$ENV_FILE"
  fi
  chown "$OWNER" "$ENV_FILE"
  echo "Mise à jour interne à l'application désactivée (AUTO_UPDATE_HOUR=-1)."
fi

echo
echo "✅ Minuteur installé."
systemctl list-timers boxmail-update.timer --no-pager || true
echo
echo "Pour déclencher une mise à jour tout de suite :"
echo "  sudo systemctl start boxmail-update.service && journalctl -u boxmail-update -n 30 --no-pager"
