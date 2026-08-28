# Database migrations

These MySQL 8.0 migrations are an immutable, ordered history. For a new database, review the scripts and apply every numbered `.sql` file exactly once in ascending order:

1. `001_create_logistics_api_schema.sql` creates the `cmhub` database, base tables, and least-privileged application user. Replace `REPLACE_WITH_A_LONG_RANDOM_PASSWORD` in a controlled copy before applying it; never commit the real password.
2. `002_add_upstream_raw_payload.sql` adds upstream-order fields, backfills pre-existing rows with an empty JSON object, and then makes `shipments.raw_data` required.
3. `003_harden_upstream_integrations.sql` separates a client organization from its rotatable API keys, adds per-key scopes and lifecycle fields, backfills all existing keys, and creates the durable inbound-message/idempotency ledger.
4. `004_add_label_assets_and_shipment_events.sql` adds private content-addressed PDF assets, the current-asset pointer on shipments, and a general shipment event history. It migrates the earlier `SHIPMENT_UPSERTED` records out of the print-specific log model.
5. `005_add_warehouse_identity_and_print_attempts.sql` adds first-party warehouse users and memberships, HttpOnly-session persistence, per-warehouse client access, browser workstation identity, and QZ submission-attempt auditing.
6. `006_add_outbound_webhook_outbox.sql` adds encrypted per-client callback configuration, a transactional result outbox, leased delivery attempts, dead-letter state, and manual replay cycles.

Do not edit, skip, or replay a migration after it has been applied to a shared environment. A repository checkout does not prove which migrations production has received: verify the live schema and deployment record first, take a backup, test against a production-like copy, and schedule the DDL/backfill for an approved change window. Add future changes as the next numbered migration. In particular, do not use `001` to rotate an existing MySQL password; `CREATE USER IF NOT EXISTS` leaves an existing account unchanged.

Before this baseline was committed, the upstream-payload change existed in draft files as both an expanded `001` and `004_add_upstream_raw_payload.sql`. If an existing environment already has `shipments.order_id` and `shipments.raw_data`, treat `002` as that same logical change: do not execute it again. Have the database owner reconcile the verified schema with the deployment record instead.

Client API keys are operational credentials, not seed data. After the API service is configured and built, create a test client from `services/cloud-api` with:

```bash
npm run create-client-key -- --code jfk-test-client --name "JFK Test Client" --environment test --rate-limit 60
```

The CLI creates the client when the code is new, or issues an additional key when that client already exists. `--name` is only required for a new client. Optional `--scopes` accepts a comma-separated subset of `shipments:write,shipments:read,labels:write`. The plaintext key is shown once; move it directly to an approved password manager and never put it in SQL, logs, screenshots, chat, or source control.

Safe rotation deliberately permits overlap:

```bash
# 1. Issue a replacement while the old key still works.
npm run create-client-key -- --code jfk-test-client --environment live --scopes shipments:write,shipments:read,labels:write

# 2. Update and verify the upstream service, then revoke only the old key ID.
npm run revoke-client-key -- --key-id OLD_KEY_ID
```

The key ID is the 12-character segment after `cmh_live_` or `cmh_test_`; it is an identifier, not a secret. Do not revoke the old key until the caller has successfully used the replacement.

Callback signing secrets are separate from inbound API Keys. After migration `006`, build the service, generate a per-client signing secret, configure it at the upstream receiver, and only then activate its URL in CM-HUB. Supply the signing secret through protected environment input, never argv:

```bash
npm run generate-webhook-secret
read -s CMHUB_WEBHOOK_SIGNING_SECRET
export CMHUB_WEBHOOK_SIGNING_SECRET
npm run configure-client-callback -- --client-code jfk-test-client --url https://partner.example.com/hooks/cmhub
unset CMHUB_WEBHOOK_SIGNING_SECRET
```

`OUTBOUND_WEBHOOK_MASTER_KEY` must already contain a base64-encoded 32-byte master key. It encrypts callback secrets at rest and is not the HMAC secret shared with a client. Back it up in the server secret manager; losing it makes stored callback credentials unreadable.

For master-key rotation, configure both versions in `OUTBOUND_WEBHOOK_MASTER_KEYS` (for example `v1=<old>,v2=<new>`), set `OUTBOUND_WEBHOOK_KEY_VERSION=v2`, restart so both old and new ciphertext remain readable, then run `npm run rotate-webhook-master-key`. Verify `SELECT encryption_key_version, COUNT(*) FROM client_callback_endpoints GROUP BY encryption_key_version` and a signed test callback before removing `v1`. The command locks and re-encrypts all endpoint secrets in one transaction; any unreadable row rolls back the whole operation.

When outbound delivery is enabled, startup checks every active endpoint's `encryption_key_version`, performs an AES-GCM decryptability check without logging plaintext, and refuses to listen if a key is missing or wrong. This fail-closed check prevents a partial or incorrect key rotation from consuming events into dead letter.

The delivery lease must exceed the HTTP timeout by at least 10 seconds. Configuration validation rejects a shorter lease so a second PM2 worker cannot reclaim and concurrently resend a request that is still within its transport timeout.

To stop future deliveries for one client, use `npm run disable-client-callback -- --client-code <code>`. Pending work returns to `WAITING_CONFIGURATION`; one request already claimed by a worker may still be in flight, so revoke the old secret at the receiver when immediate containment is required.

## Production transition for migration 003

Migration `003` must be applied and verified **before** starting a binary that queries `integration_api_keys` or `inbound_messages`. It preserves the legacy credential columns in `clients` and backfills each existing credential, so the previously deployed binary can still be rolled back during the transition. Do not rerun the migration and do not remove those legacy columns in the same release.

After applying it, verify only non-secret metadata:

```sql
SELECT COUNT(*) AS clients FROM clients;
SELECT COUNT(*) AS migrated_keys FROM integration_api_keys;
SELECT client_id, key_id, environment, key_status, scopes, expires_at, last_used_at
FROM integration_api_keys;
```

`inbound_messages` is the durable idempotency source of truth. Redis is only the short processing lock. A completed idempotency key is not recycled, and reusing it with a different JSON payload returns a conflict instead of mutating the prior shipment.

## Production transition for migration 004

Migration `004` must be applied before deploying the PDF-upload release. Create and permission the directory configured by `LABEL_STORAGE_ROOT` first; it must live outside the Git checkout, must not be served directly by Nginx, and must be writable only by the API process user. The application stores opaque internal keys in MySQL and the PDF bytes under that private root.

The migration does not fetch any existing `label_url`. Existing shipments remain without a CM-HUB-owned asset until the upstream system actively uploads the PDF through the documented endpoint.

## Production transition for migration 005

Migration `005` must be applied before enabling the warehouse login and synchronization release. Warehouse users are deliberately separate from upstream API clients: never paste an upstream API Key into a browser. Bootstrap the first warehouse administrator with the application CLI after the migration, then grant that warehouse access only to the required upstream client codes.

After building `services/cloud-api`, bootstrap the first administrator without putting the password in argv or a committed file:

```bash
cd services/cloud-api
read -s CMHUB_BOOTSTRAP_PASSWORD
export CMHUB_BOOTSTRAP_PASSWORD
npm run create-warehouse-admin -- \
  --warehouse-code jfk-warehouse \
  --warehouse-name "JFK Warehouse" \
  --email admin@example.com \
  --display-name "JFK Admin" \
  --client-codes jfk-test-client
unset CMHUB_BOOTSTRAP_PASSWORD
```

The command refuses to reset an existing user. `shipment_delivery_changes` is the monotonic warehouse-delivery ledger; shipment and label mutations append to it in the same database transaction so millisecond timestamp collisions cannot skip work.

## Production transition for migration 006

Apply `006` before starting this binary because every new print attempt writes its outbound event in the same transaction. Leave `OUTBOUND_WEBHOOK_ENABLED=false` while configuring the master key, client HTTPS endpoint, and upstream verifier. Then enable the worker, restart the API, and verify a signed test event. Multiple PM2 instances are safe because workers claim rows through database leases; do not run a second ad-hoc delivery script.

Dead letters remain immutable business evidence. A warehouse `ADMIN` may requeue one through the authenticated warehouse API after fixing the cause; the replay starts a new audited cycle and keeps all prior attempts.
