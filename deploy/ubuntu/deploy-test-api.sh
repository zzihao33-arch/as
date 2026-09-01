#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/cmhub-api-test}"
BRANCH="${BRANCH:-staging}"
REPO_URL="${REPO_URL:-https://github.com/zzihao33-arch/as.git}"
ENV_FILE="$APP_DIR/services/cloud-api/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing protected test environment file: $ENV_FILE" >&2
  exit 1
fi
if [[ "$(stat -c '%a' "$ENV_FILE")" != "600" ]]; then
  echo "Test environment file must use mode 600." >&2
  exit 1
fi
test_database="$(sed -n 's/^MYSQL_DATABASE=//p' "$ENV_FILE" | tail -n 1)"
if [[ ! "$test_database" =~ test ]]; then
  echo "Refusing to deploy: MYSQL_DATABASE must be an isolated test database." >&2
  exit 1
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Refusing to deploy over tracked server-side changes." >&2
  exit 1
fi
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

cd services/cloud-api
npm ci
npm run typecheck
npm test
npm run build
npm run migrate
npm prune --omit=dev

pm2 startOrReload "$APP_DIR/deploy/ubuntu/ecosystem.test.config.cjs" --env production
pm2 save

for attempt in {1..20}; do
  if curl --fail --silent --show-error http://127.0.0.1:8080/healthz >/dev/null; then
    git -C "$APP_DIR" rev-parse HEAD > "$APP_DIR/.deployed-sha"
    echo "Test API deployment healthy at $(git -C "$APP_DIR" rev-parse --short HEAD)."
    exit 0
  fi
  sleep 1
done

pm2 logs cmhub-cloud-api-test --lines 80 --nostream >&2 || true
echo "Test API failed its local health check." >&2
exit 1
