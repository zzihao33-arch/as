# CM-HUB test environment

The stable test release path is intentionally separate from production:

- Git branch: `staging`
- Vercel: automatic Preview deployment with `VITE_CMHUB_API_BASE_URL=https://api-test.cmhubtool.com`
- API host: `tyg-api-test` (`170.106.132.190`)
- API domain: `api-test.cmhubtool.com`
- server checkout: `/opt/cmhub-api-test`
- PM2 process: `cmhub-cloud-api-test`
- MySQL database: a name containing `test` (recommended: `tyg_integration_test`)
- COS prefix: `test`

Never point a test deployment at the production database or an unprefixed production COS namespace.

## One-time server bootstrap

Generate a dedicated Ed25519 key for GitHub Actions. Put only the public key into `DEPLOY_PUBLIC_KEY`, then execute `deploy/ubuntu/bootstrap-test-server.sh` as root through the Tencent Cloud console. The script installs Node.js 22, PM2, Nginx, Redis, Certbot, the restricted SSH command, and the test checkout.

Populate `/opt/cmhub-api-test/services/cloud-api/.env` with mode `0600`. Test uses `NODE_ENV=production` so Secure cookies and production safety checks remain active. Required differences from production are:

```dotenv
MYSQL_DATABASE=tyg_integration_test
WAREHOUSE_ALLOWED_ORIGINS=https://test.cmhubtool.com
LABEL_STORAGE_BACKEND=cos
COS_BUCKET=cmhub-labels-prod-1476409815
COS_REGION=na-ashburn
COS_PREFIX=test
OUTBOUND_WEBHOOK_ENABLED=false
```

Use a test-only MySQL account with DDL/DML privileges on only `tyg_integration_test`. The deployment runner records checksums in `schema_migrations`, skips database/user/grant statements from the immutable baseline files, and applies only pending application-schema migrations.

## GitHub environment secrets

Create GitHub environment `test` and configure:

- `CMHUB_TEST_DEPLOY_HOST`: `170.106.132.190`
- `CMHUB_TEST_DEPLOY_PORT`: `22`
- `CMHUB_TEST_DEPLOY_USER`: `cmhub`
- `CMHUB_TEST_DEPLOY_SSH_KEY`: base64 of the dedicated private key
- `CMHUB_TEST_DEPLOY_KNOWN_HOSTS`: pinned `ssh-keyscan` result after independently verifying the host fingerprint

Pushes to `staging` run verification, restricted SSH deployment, migration, PM2 reload, local health check, and public HTTPS health check. Production workflow and secrets are not reused.

## DNS and TLS

Create an `A` record for `api-test.cmhubtool.com` pointing to `170.106.132.190`, then run:

```bash
sudo certbot --nginx -d api-test.cmhubtool.com
curl -fsS https://api-test.cmhubtool.com/healthz
```

The Vercel test frontend must use one stable exact origin because warehouse sessions use credentials and the API deliberately rejects wildcard CORS.
