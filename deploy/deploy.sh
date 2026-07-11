#!/usr/bin/env bash
# Déploiement sur le serveur OVH (à lancer depuis la racine du repo, sur le serveur).
set -euo pipefail

cd "$(dirname "$0")/.."

BEFORE=$(git rev-parse HEAD)
git pull

# npm ci (strict mais lent) seulement si les dépendances ont changé —
# la plupart des deploys n'y touchent pas.
if [ ! -d node_modules ] || ! git diff --quiet "$BEFORE" HEAD -- package-lock.json; then
  npm ci
else
  echo "→ dépendances inchangées, installation sautée"
fi

npm run build

# Premier lancement : pm2 start deploy/ecosystem.config.cjs && pm2 save
pm2 restart foolscribe

echo "✔ foolscribe déployé"
