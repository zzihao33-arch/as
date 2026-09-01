#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this one-time bootstrap as root." >&2
  exit 1
fi
: "${DEPLOY_PUBLIC_KEY:?Set DEPLOY_PUBLIC_KEY to the dedicated GitHub Actions public key}"

DEPLOY_USER="${DEPLOY_USER:-cmhub}"
APP_DIR="${APP_DIR:-/opt/cmhub-api-test}"
BRANCH="${BRANCH:-staging}"
REPO_URL="${REPO_URL:-https://github.com/zzihao33-arch/as.git}"

apt-get update
apt-get install -y ca-certificates curl git nginx redis-server certbot python3-certbot-nginx
if ! command -v node >/dev/null || [[ "$(node --version | tr -d v | cut -d. -f1)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install --global pm2

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 "$APP_DIR"
if [[ ! -d "$APP_DIR/.git" ]]; then
  runuser -u "$DEPLOY_USER" -- git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$APP_DIR"
fi

install -o root -g root -m 0755 \
  "$APP_DIR/deploy/ubuntu/restricted-test-deploy-command.sh" \
  /usr/local/sbin/cmhub-test-deploy-command
install -o root -g root -m 0644 \
  "$APP_DIR/deploy/ubuntu/nginx/cmhub-cloud-api-test.conf" \
  /etc/nginx/sites-available/cmhub-cloud-api-test
ln -sfn /etc/nginx/sites-available/cmhub-cloud-api-test /etc/nginx/sites-enabled/cmhub-cloud-api-test

install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "/home/$DEPLOY_USER/.ssh"
authorized_keys="/home/$DEPLOY_USER/.ssh/authorized_keys"
touch "$authorized_keys"
chmod 0600 "$authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "$authorized_keys"
forced_key="command=\"/usr/local/sbin/cmhub-test-deploy-command\",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding $DEPLOY_PUBLIC_KEY"
grep -Fqx "$forced_key" "$authorized_keys" || printf '%s\n' "$forced_key" >> "$authorized_keys"

# The public SSH port is used only by the forced GitHub Actions deploy key.
# Keep administrative recovery on Tencent Cloud TAT instead of password SSH.
install -d -o root -g root -m 0755 /etc/ssh/sshd_config.d
sshd_drop_in=/etc/ssh/sshd_config.d/00-cmhub-test.conf
printf '%s\n' \
  'PasswordAuthentication no' \
  'KbdInteractiveAuthentication no' \
  'PermitRootLogin no' \
  'PubkeyAuthentication yes' \
  > "$sshd_drop_in"
chmod 0644 "$sshd_drop_in"
/usr/sbin/sshd -t
systemctl reload ssh

if [[ ! -f "$APP_DIR/services/cloud-api/.env" ]]; then
  install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0600 \
    "$APP_DIR/services/cloud-api/.env.example" \
    "$APP_DIR/services/cloud-api/.env"
fi

systemctl enable --now redis-server nginx
nginx -t
systemctl reload nginx
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$DEPLOY_USER" --hp "/home/$DEPLOY_USER"

if command -v ufw >/dev/null; then
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
fi

echo "Bootstrap complete. Populate the protected .env, configure DNS/TLS, then run the test deploy."
