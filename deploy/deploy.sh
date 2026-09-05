#!/usr/bin/env bash
# FALLBACK MANUEL — le déploiement normal passe par GitHub Actions
# (.github/workflows/deploy.yml : build sur un runner, puis rsync + pm2 sur le
# VPS via deploy/release.sh). Ce script-ci compile SUR le serveur : il sature
# sa RAM/CPU et impacte les autres sites. À n'utiliser que si la CI est HS.
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
