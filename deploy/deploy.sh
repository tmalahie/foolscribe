#!/usr/bin/env bash
# Déploiement sur le serveur OVH (à lancer depuis la racine du repo, sur le serveur).
set -euo pipefail

cd "$(dirname "$0")/.."

git pull
npm ci
npm run build

# Premier lancement : pm2 start deploy/ecosystem.config.cjs && pm2 save
pm2 restart foolscribe

echo "✔ foolscribe déployé"
