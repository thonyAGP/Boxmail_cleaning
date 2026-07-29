#!/usr/bin/env bash
# Amorçage de la mise à jour — CE FICHIER DOIT RESTER MINUSCULE ET STABLE.
#
# Il récupère la DERNIÈRE version de deploy/update.sh depuis le dépôt AVANT de
# l'exécuter. C'est ce qui rend le mécanisme auto-réparant : si un update.sh
# bogué est publié un jour, le passage suivant récupère la version corrigée et
# repart — sans connexion SSH. Le seul cas qui exige encore une intervention
# serait que ce fichier-ci soit cassé : d'où sa taille, et le fait qu'il ne
# fasse aucun traitement.
#
# On extrait le script via `git show` vers logs/ plutôt que `git checkout` :
# checkout modifierait l'index et le fichier suivi, ce qui ferait échouer le
# `git merge --ff-only` d'update.sh juste après.

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
mkdir -p logs

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')
if [ -n "$BRANCH" ] && git fetch origin "$BRANCH" >/dev/null 2>&1 \
  && git show "origin/$BRANCH:deploy/update.sh" > logs/update-next.sh 2>/dev/null \
  && [ -s logs/update-next.sh ]; then
  exec bash logs/update-next.sh "$ROOT"
fi

# Dépôt injoignable : on tente quand même avec la version locale.
exec bash deploy/update.sh "$ROOT"
