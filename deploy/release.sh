#!/usr/bin/env bash
# Exécuté SUR le VPS par le job GitHub Actions (.github/workflows/deploy.yml),
# depuis la copie fraîchement rsyncée dans <app>/.deploy/.
# Il ne compile rien : il bascule le build reçu en place puis redémarre pm2.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: release.sh CHEMIN_APP_SUR_LE_SERVEUR" >&2
  exit 2
fi
APP_DIR=$(cd "$1" && pwd)
STAGING="$APP_DIR/.deploy"

# pm2 tourne sous root (daemon /root/.pm2, binaires dans /root/.nvm en 0700) :
# l'utilisateur de déploiement n'y accède qu'au travers du wrapper sudo, voir
# deploy/foolscribe-pm2. En root (déploiement manuel de dépannage), on appelle
# pm2 directement.
PM2_WRAPPER=/usr/local/sbin/foolscribe-pm2
if [ "$(id -u)" -ne 0 ] && [ -x "$PM2_WRAPPER" ]; then
  app_pm2() { sudo -n "$PM2_WRAPPER" "$@"; }
else
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" >/dev/null
  fi
  export PATH="$PATH:/usr/local/bin:$HOME/.local/bin"
  command -v pm2 >/dev/null || {
    echo "✖ ni $PM2_WRAPPER ni pm2 ne sont accessibles depuis ce shell" >&2
    exit 1
  }
  app_pm2() {
    case "${1:-}" in
      restart)
        (cd "$APP_DIR" && pm2 startOrRestart deploy/ecosystem.config.cjs --update-env)
        ;;
      logs) pm2 logs foolscribe --lines "${2:-40}" --nostream ;;
      status) pm2 describe foolscribe ;;
    esac
  }
fi

SWAPPED=()

# Bascule un répertoire du staging vers l'app. La copie est en hard links
# (instantanée, même système de fichiers) ; le staging reste intact pour que le
# rsync suivant reste incrémental. L'ancien répertoire est gardé en .old le
# temps du health check.
swap_dir() {
  local rel=$1
  local src="$STAGING/$rel" dst="$APP_DIR/$rel"
  [ -d "$src" ] || return 0
  rm -rf "$dst.new" "$dst.old"
  mkdir -p "$(dirname "$dst")"
  cp -al "$src" "$dst.new"
  if [ -e "$dst" ]; then
    mv "$dst" "$dst.old"
  fi
  mv "$dst.new" "$dst"
  SWAPPED+=("$rel")
}

copy_file() {
  local rel=$1
  if [ -f "$STAGING/$rel" ]; then
    cp -f "$STAGING/$rel" "$APP_DIR/$rel"
  fi
}

echo "→ bascule du build dans $APP_DIR"
swap_dir node_modules
swap_dir server/node_modules
swap_dir server/dist
swap_dir web/dist
copy_file package.json
copy_file package-lock.json
copy_file server/package.json
copy_file web/package.json
cp -f "$STAGING/deploy/ecosystem.config.cjs" "$APP_DIR/deploy/ecosystem.config.cjs"
cp -f "$STAGING/deploy/release.sh" "$APP_DIR/deploy/release.sh"

rollback() {
  echo "✖ échec du déploiement — retour à la version précédente" >&2
  local rel
  for rel in "${SWAPPED[@]}"; do
    [ -d "$APP_DIR/$rel.old" ] || continue
    rm -rf "$APP_DIR/$rel"
    mv "$APP_DIR/$rel.old" "$APP_DIR/$rel"
  done
  app_pm2 restart >/dev/null 2>&1 || true
  exit 1
}

echo "→ redémarrage pm2"
app_pm2 restart || rollback

# Health check : le serveur doit répondre sur son port local.
# `|| true` : pas de ligne PORT= dans le .env n'est pas une erreur (défaut 3001).
PORT=$(grep -E '^[[:space:]]*PORT=' "$APP_DIR/.env" 2>/dev/null | tail -1 | tr -cd '0-9' || true)
PORT=${PORT:-3001}
# `-f -s` sans `-S` : tant que le serveur démarre (initDb + resetStaleAnalyses,
# ~10 s), les tentatives échouent normalement — inutile de les afficher.
for attempt in $(seq 1 30); do
  if curl -fs -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/api/config"; then
    for rel in "${SWAPPED[@]}"; do rm -rf "$APP_DIR/$rel.old"; done
    echo "✔ foolscribe déployé (port $PORT, prêt en ~$((attempt * 2)) s)"
    exit 0
  fi
  if [ "$attempt" -eq 1 ]; then
    echo "→ attente du démarrage du serveur (60 s max)…"
  fi
  sleep 2
done

echo "✖ pas de réponse sur http://127.0.0.1:$PORT/api/config après 60 s" >&2
app_pm2 logs 40 || true
rollback
