#!/usr/bin/env bash
# Mise à jour du serveur Boxmail — exécutée DEPUIS L'EXTÉRIEUR de l'application.
#
# POURQUOI CE FICHIER EXISTE (panne du 29/07/2026) :
# la mise à jour vivait DANS l'application. Quand elle cassait, le code qui
# tournait était justement celui qui contenait le bug : il rejouait la même
# commande cassée à chaque tentative, et il fallait une connexion SSH pour
# s'en sortir. Deux mises à jour sur trois ont fini en intervention manuelle.
#
# Sur Windows le problème n'existe pas : MailAssistant.bat fait le pull, le
# build et le lancement depuis l'extérieur. Ce script est son équivalent Linux,
# déclenché par un minuteur systemd (deploy/install-updater.sh).
#
# Garanties :
#  - si une étape échoue, on revient sur le commit précédent et on recompile :
#    mieux vaut la version d'hier qui marche ;
#  - le résultat est écrit dans logs/update-status.json, que l'interface lit
#    pour l'afficher dans ⚙️ Paramètres ;
#  - aucune migration ici : elles s'appliquent au redémarrage, base libre
#    (ensureMigrationsApplied, src/db/migrate.ts).
#
# Usage : bash deploy/update.sh [racine_du_dépôt]

set -uo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT" || { echo "racine introuvable : $ROOT"; exit 1; }

mkdir -p logs backups
LOG="logs/update.log"
STATUS="logs/update-status.json"
PM2_APP="${BOXMAIL_PM2_APP:-boxmail-mcp}"

log() { printf '%s | %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }
run() { log "\$ $*"; "$@" >>"$LOG" 2>&1; }

# Échappement JSON minimal (pas de dépendance à jq, absent d'une image Minimal).
json_escape() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_status() { # $1=result $2=message
  printf '{"ranAt":"%s","result":"%s","message":"%s","commit":"%s"}\n' \
    "$(date -Iseconds)" "$1" "$(json_escape "$2")" \
    "$(git rev-parse --short HEAD 2>/dev/null || echo inconnu)" > "$STATUS"
  log "→ $1 : $2"
}

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || {
  write_status "échec" "dépôt git illisible dans $ROOT"; exit 1; }
PREV=$(git rev-parse HEAD)

if ! git fetch origin "$BRANCH" >>"$LOG" 2>&1; then
  write_status "échec" "git fetch impossible (réseau ou accès au dépôt)"; exit 1
fi

BEHIND=$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)
if [ "$BEHIND" = "0" ]; then
  write_status "à jour" "aucune nouveauté"; exit 0
fi
log "$BEHIND nouveauté(s) à appliquer"

# Filet avant une éventuelle migration. La sauvegarde de référence reste celle
# de l'application (VACUUM INTO, quotidienne) ; ceci n'est qu'un doublon local.
if [ -f data/boxmail.db ]; then
  cp -a data/boxmail.db "backups/avant-maj-$(date +%Y%m%d-%H%M%S).db" 2>>"$LOG" \
    && log "sauvegarde de la base faite" || log "sauvegarde impossible — on continue"
fi

# ÉTAPES CONDITIONNELLES (01/08 : « chaque mise à jour prend 3 minutes ») :
# npm install, prisma generate et tsc ne tournent que si leurs ENTRÉES ont
# changé — empreintes stockées dans logs/ (non suivi par git, donc sans effet
# sur le merge --ff-only). Même logique que scripts/supervisor.mjs côté
# Windows. Une mise à jour qui ne touche que web/ = merge + restart, ~10 s.
#
# `--include=dev` EST OBLIGATOIRE quand npm install tourne : pm2 lance l'app
# avec NODE_ENV=production et ce script en hérite. Sans le flag, npm écarte
# les devDependencies, @types/node disparaît et le build meurt sur « TS2688 ».
# C'est LA panne du 29/07.
hash_file() { sha1sum "$1" 2>/dev/null | cut -d' ' -f1; }

OK=1
run git merge --ff-only "origin/$BRANCH" || OK=0

if [ "$OK" = 1 ]; then
  LOCK_NEW=$(hash_file package-lock.json)
  if [ ! -d node_modules ] || [ "$(cat logs/state-lock 2>/dev/null)" != "$LOCK_NEW" ]; then
    if run npm install --include=dev --no-audit --no-fund; then
      printf '%s' "$LOCK_NEW" > logs/state-lock
    else OK=0; fi
  else
    log "dépendances inchangées — npm install sauté"
  fi
fi

if [ "$OK" = 1 ]; then
  SCHEMA_NEW=$(hash_file prisma/schema.prisma)
  if [ ! -d node_modules/.prisma/client ] || [ "$(cat logs/state-schema 2>/dev/null)" != "$SCHEMA_NEW" ]; then
    if run npm run db:generate; then
      printf '%s' "$SCHEMA_NEW" > logs/state-schema
    else OK=0; fi
  else
    log "schéma de base inchangé — prisma generate sauté"
  fi
fi

if [ "$OK" = 1 ]; then
  SRC_NEW="$(git rev-parse HEAD:src 2>/dev/null)|$(hash_file tsconfig.json)"
  if [ ! -f dist/index.js ] || [ "$(cat logs/state-src 2>/dev/null)" != "$SRC_NEW" ]; then
    if run npm run build; then
      printf '%s' "$SRC_NEW" > logs/state-src
    else OK=0; fi
  else
    log "code serveur inchangé — compilation sautée"
  fi
fi

if [ "$OK" = 1 ]; then
  run pm2 restart "$PM2_APP"
  write_status "mis à jour" "$BEHIND nouveauté(s) appliquée(s)"
  exit 0
fi

# Échec : retour sur la version qui fonctionnait. Les empreintes sont effacées
# pour forcer une passe COMPLÈTE au prochain passage — un état à moitié vrai
# peut être la cause même de l'échec.
rm -f logs/state-lock logs/state-schema logs/state-src
TAIL=$(tail -n 12 "$LOG" | tr -d '\r')
log "ÉCHEC — retour sur $PREV"
run git reset --hard "$PREV"
run npm install --include=dev --no-audit --no-fund
run npm run build
run pm2 restart "$PM2_APP"
write_status "échec" "mise à jour abandonnée, retour sur ${PREV:0:7}. Détail : $TAIL"
exit 1
