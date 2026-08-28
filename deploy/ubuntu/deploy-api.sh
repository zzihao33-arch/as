#!/usr/bin/env bash
set -Eeuo pipefail

# Run as the non-root deployment user. Required once: git, Node.js 22+, and PM2.
APP_DIR="${APP_DIR:-/opt/cmhub-api}"
BRANCH="${BRANCH:-master}"
REPO_URL="${REPO_URL:-}"

if [[ ! -d "$APP_DIR/.git" ]]; then
  if [[ -z "$REPO_URL" ]]; then
    echo "REPO_URL is required for the first deployment, e.g. https://github.com/zzihao33-arch/as.git" >&2
    exit 1
  fi
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

cd services/cloud-api
npm ci
npm run build
npm prune --omit=dev

pm2 startOrReload "$APP_DIR/deploy/ubuntu/ecosystem.config.cjs" --env production
pm2 save
pm2 status cmhub-cloud-api
