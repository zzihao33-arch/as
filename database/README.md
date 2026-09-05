# Database migrations

These MySQL 8.0 migrations are an immutable, ordered history. For a new database, review the scripts and apply every numbered `.sql` file exactly once in ascending order:

1. `001_create_logistics_api_schema.sql` creates the `cmhub` database, base tables, and least-privileged application user. Replace `REPLACE_WITH_A_LONG_RANDOM_PASSWORD` in a controlled copy before applying it; never commit the real password.
2. `002_add_upstream_raw_payload.sql` adds upstream-order fields, backfills pre-existing rows with an empty JSON object, and then makes `shipments.raw_data` required.
3. `003_harden_upstream_integrations.sql` separates a client organization from its rotatable API keys, adds per-key scopes and lifecycle fields, backfills all existing keys, and creates the durable inbound-message/idempotency ledger.
4. `004_add_label_assets_and_shipment_events.sql` adds private content-addressed PDF assets, the current-asset pointer on shipments, and a general shipment event history. It migrates the earlier `SHIPMENT_UPSERTED` records out of the print-specific log model.
5. `005_add_warehouse_identity_and_print_attempts.sql` adds first-party warehouse users and memberships, HttpOnly-session persistence, the now-deprecated `warehouse_client_access` table, browser workstation identity, and QZ submission-attempt auditing.
6. `006_add_outbound_webhook_outbox.sql` adds encrypted per-client callback configuration, a transactional result outbox, leased delivery attempts, dead-letter state, and manual replay cycles.
7. `007_add_global_identity_and_rbac.sql` adds global login names, platform administrators, permission-based roles, renewable sessions, deletion-safe actor references, and security audit events. Existing warehouse `ADMIN` members become global `SYSTEM_ADMIN` users; their generated transition login names must be replaced before releasing the new login UI.
8. `008_add_shared_work_batches_and_intercepts.sql` adds shared Excel/PDF work batches, cross-workstation claim state, shared print attempts, and the global intercept registry.
9. `009_add_air_pickup_lifecycle.sql` adds globally shared air-pickup orders, atomic receiving/handover batches, private evidence metadata, lifecycle permissions, and immutable event history.
10. `010_integrate_handover_document_permissions.sql` moves the existing handover-document permission catalog under Air Pickup Management without binding legacy browser-local records.
11. `011_link_air_pickups_clients_shipments_and_receipt_evidence.sql` records source clients on air-pickup orders, links shipments to their air-pickup order, adds receipt-batch evidence, and enables server-derived exchange progress.
12. `012_add_attendance_and_payroll.sql` adds cloud attendance locations, effective-dated shift rules, accepted/rejected punch evidence, daily results, supervisor-reviewed appeals, effective-dated pay rates, payroll adjustments, and immutable payroll-run snapshots.
13. `013_add_tyg_v11_label_versions.sql` adds immutable TYG v1.1 PDF label-version records and retention metadata.
14. `014_add_customer_profiles.sql` separates manually managed business/upstream customer profiles from API integration identities, backfills integrated upstream customers, and records the single customer ownership of each air-pickup order.

Do not edit, skip, or replay a migration after it has been applied to a shared environment. A repository checkout does not prove which migrations production has received: verify the live schema and deployment record first, take a backup, test against a production-like copy, and schedule the DDL/backfill for an approved change window. Add future changes as the next numbered migration. In particular, do not use `001` to rotate an existing MySQL password; `CREATE USER IF NOT EXISTS` leaves an existing account unchanged.

Before this baseline was committed, the upstream-payload change existed in draft files as both an expanded `001` and `004_add_upstream_raw_payload.sql`. If an existing environment already has `shipments.order_id` and `shipments.raw_data`, treat `002` as that same logical change: do not execute it again. Have the database owner reconcile the verified schema with the deployment record instead.

Client API keys are operational credentials, not seed data. After the API service is configured and built, create a test client from `services/cloud-api` with:

```bash
npm run create-client-key -- --code jfk-test-client --name "JFK Test Client" --environment test --rate-limit 60
```

The CLI creates the integration client when the code is new, or issues an additional key when that client already exists. After migration `014`, a new API client automatically connects to the existing upstream customer profile with the same customer code; if none exists, the CLI creates an already-integrated upstream profile. A business customer can never be converted into an API integration client. `--name` is only required for a new client. Optional `--scopes` accepts a comma-separated subset of `shipments:write,shipments:read,labels:write`. The plaintext key is shown once; move it directly to an approved password manager and never put it in SQL, logs, screenshots, chat, or source control.

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

Migration `005` must be applied before enabling the warehouse login and synchronization release. Warehouse users are deliberately separate from upstream API clients: never paste an upstream API Key into a browser. All active warehouse members can process every upstream client's shipments, including retained history from a subsequently disabled integration; `warehouse_client_access` is retained only as immutable migration history and is not consulted by the application.

After building `services/cloud-api`, bootstrap the first administrator without putting the password in argv or a committed file:

```bash
cd services/cloud-api
read -s CMHUB_BOOTSTRAP_PASSWORD
export CMHUB_BOOTSTRAP_PASSWORD
npm run create-warehouse-admin -- \
  --warehouse-code jfk-warehouse \
  --warehouse-name "JFK Warehouse" \
  --email admin@example.com \
  --display-name "JFK Admin"
unset CMHUB_BOOTSTRAP_PASSWORD
```

The command refuses to reset an existing user. `shipment_delivery_changes` is the monotonic warehouse-delivery ledger; shipment and label mutations append to it in the same database transaction so millisecond timestamp collisions cannot skip work.

## Production transition for migration 006

Apply `006` before starting this binary because every new print attempt writes its outbound event in the same transaction. Leave `OUTBOUND_WEBHOOK_ENABLED=false` while configuring the master key, client HTTPS endpoint, and upstream verifier. Then enable the worker, restart the API, and verify a signed test event. Multiple PM2 instances are safe because workers claim rows through database leases; do not run a second ad-hoc delivery script.

Dead letters remain immutable business evidence. A warehouse `ADMIN` may requeue one through the authenticated warehouse API after fixing the cause; the replay starts a new audited cycle and keeps all prior attempts.

## Production transition for migration 007

Do not deploy the login-name/RBAC binary until every existing administrator has an approved `login_name`. Migration `007` generates a deterministic transition value so the schema can be applied safely without inventing a human credential. After the migration, set approved login names through the new administrative command or management interface, verify that at least one active `SYSTEM_ADMIN` can authenticate, and only then switch the frontend login form.

The legacy membership `role` enum remains populated for rollback compatibility, but the new binary authorizes through `warehouse_roles` and `warehouse_role_permissions`. Do not edit permission rows ad hoc in production; permission codes are application contracts and must be introduced through reviewed migrations.

Account deletion is permanent for credentials and personal profile data. It must first revoke sessions and memberships, then replace user references in retained print facts with anonymous actor references. Never cascade-delete `print_attempts`, shipment events, or upstream callback evidence when an employee leaves.

## Production transition for migration 008

Apply `008` only after `007` and before enabling shared imports in the frontend. The new work-batch tables are global warehouse work data by confirmed product policy: they are not partitioned by upstream client or selected warehouse. Workstations still carry a warehouse context for audit, while any authorized operator can claim an item from any active shared batch.

Before rollout, verify the private `LABEL_STORAGE_ROOT` has sufficient capacity and backup coverage for the expected 20,000-PDF imports. Publish requires `mapping_count = pdf_count`, so an incomplete draft remains invisible to scan claims. Validate with at least two real Windows/QZ workstations: one imports and publishes, the other scans without importing; repeat with a global intercept, simultaneous scans, a lost completion response, `RESULT_UNKNOWN`, batch close, and supervisor offline emergency mode.

## Production transition for migration 009

Apply `009` before enabling the air-pickup navigation item. The module is intentionally global across authorized warehouse accounts: source-client ownership is recorded for provenance and callbacks, but it does not partition warehouse visibility. The API still records the acting account on every state transition.

Evidence bytes use the existing private storage abstraction and must remain outside the Git checkout and outside Nginx public roots. Keep at least three years of backup coverage. Before production rollout, verify atomic rollback with a mixed-validity 200-order receipt batch, a mixed-validity handover batch, normalized duplicate bill numbers, two concurrent operators, evidence count limits, and a supervisor-only correction/removal flow.

## Production transition for migration 010

Apply `010` after `009`. It only renames and regroups the existing `bol.*` permission catalog entries under Air Pickup Management; permission codes and grants remain unchanged. It deliberately does not migrate or bind browser-local BOL records to cloud air-pickup orders or handover batches.

## Production transition for migration 011

Apply `011` after `010` and before deploying the unified inbound-batch endpoint or source/progress UI. Existing air-pickup rows remain visible with the explicit `未绑定客户` snapshot; the migration does not guess historical customer ownership. Resolve old ownership later through a reviewed data correction, not by editing the migration.

The upstream batch endpoint derives `client_id` from the authenticated API Key and atomically binds one air-pickup order to up to 5,000 shipments. Manual creation requires an active source client. Warehouse visibility remains global. Before rollout, set `INBOUND_BATCH_JSON_LIMIT=10mb`, verify Nginx accepts that JSON size, and test one 2,000-shipment request, an idempotent replay, a cross-client conflict, a duplicate shipment, receipt photos shared by a multi-order receiving batch, and progress aggregation after `SUBMITTED`, `BLOCKED`, `FAILED`, and `RESULT_UNKNOWN` attempts.

## Production transition for migration 012

Apply `012` before enabling the cloud attendance workspace. Configure at least one active shift rule and, for mobile attendance, one active geofence before assigning operator permissions. Fixed warehouse computers must register as workstations; browser location is supplemental there, while mobile attendance requires a location with accuracy no worse than 50 meters and a matching active geofence.

Punch photos are private evidence under `LABEL_STORAGE_ROOT`; Nginx must not expose that directory. Schedule a daily retention job that removes evidence bytes and clears `storage_key` after `evidence_delete_after`, while preserving the non-biometric attendance and payroll facts required by policy. Payroll export first creates an immutable server snapshot, then downloads the workbook. Verify one cross-midnight shift, the 18-hour limit, a self-approval denial, a missing-rate export block, weekly overtime, and a deleted-user payroll snapshot before production rollout.

## Production transition for migration 015

Apply `015` before deploying pickup-document upload. These files are private operational attachments: keep their storage root outside the repository and all public web roots. Before rollout, verify the 10-file-per-order cap, 20 MB per file limit, signature checks for PDF/Office files, CSV upload, duplicate content rejection, authenticated download, and that an uploaded file remains available after the order has progressed to receipt or handover.
