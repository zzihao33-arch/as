# TYG label retention

Private PDF availability ends seven days after acceptance. Shipment metadata,
label metadata, and required audit records remain for at least two years. The
PDF worker never deletes a business record; a separate maintenance command
implements the conservative two-year metadata purge below. Physical PDF removal is asynchronous and requires
healthy storage, the scheduled worker, and an independently verified COS
lifecycle policy. These changes have not been deployed or verified against COS.

## Application rollout

1. Require MySQL 8.0.13 or later and apply `database/016_add_label_retention.sql` before starting updated API
   processes. The migration backfills expiry from `ready_at`, falling back to
   `created_at`, plus seven days. Review the count of already-expired records
   before enabling the worker; those PDFs will become unavailable immediately.
   The non-NULL expression default protects legacy inserts during rollout;
   explicit expiry is supplied by new writers. Retire old writers promptly.
   Expression-default support is described in the [MySQL reference](https://dev.mysql.com/doc/refman/8.0/en/data-type-defaults.html).
2. Every PDF publication/renewal must set `expires_at` to acceptance plus seven
   days and reset `bytes_deleted_at` to NULL. Generate a fresh immutable storage
   key for every renewal, including identical bytes and a reused asset ID.
   Never reuse or overwrite an expired generation's object key. Legacy PDF
   upload routes must follow the same rule. Writers lock shipment then asset.
3. All download/print/list readers must require READY, a future `expires_at`,
   and NULL `bytes_deleted_at`. Do not wait for the worker to enforce download
   expiry. A download already streaming at expiry may finish.
4. Instantiate `createLabelRetentionWorker({ mysql, storage })` once and call
   `runOnce()` periodically (for example every minute, with an initial startup
   call). `storage.remove` must exist and treat a missing object as success.
   Configure finite provider timeouts. Do not log provider errors or keys.
   Each call handles up to 100 rows by default (configurable 1–1000), with up to
   three removal attempts per row (configurable 1–5). Size frequency/capacity to
   the incoming volume and alert on overdue bytes or repeated deletion failures.

`runOnce()` returns `locked`, `scanned`, `expired`, `deleted`, `deleteFailures`,
and `skipped`; `expired` counts processed expired rows, including retry rows.
A nonblocking MySQL advisory lock admits one worker across API instances.
The worker commits FAILED / LABEL_EXPIRED, clears only the matching current
pointer, and emits LABEL_UNAVAILABLE only when it clears that pointer. It then
relocks shipment and asset and rechecks the same key and expiry before deletion.
It holds these row locks through storage removal and `bytes_deleted_at` commit.
This briefly delays ingestion for that shipment; finite storage timeouts matter.
Failed removals retain a NULL deletion marker and are retried on later sweeps.
The cursor advances past failed rows so later records can still be processed.
If removal succeeds but the marker transaction fails, an idempotent removal
retries safely. Metadata, hashes, shipment state history, and audit rows remain.

## Storage lifecycle verification (read only)

Use the COS console's read-only lifecycle view, or its `getBucketLifecycle` API
with a principal granted only the relevant read permission. Inspect the bucket
and exact configured `COS_PREFIX` plus `labels/` prefix. Record the returned
configuration in the deployment acceptance record; never record credentials.

- Confirm an enabled expiration rule covers every private label object and
  expires current object bytes after seven days, including unreferenced objects
  left by rolled-back ingestion and superseded generations.
- Confirm the prefix does not include unrelated business documents. Check for
  overlapping rules with earlier expiry, restrictive tag filters, replication,
  backups, object locks, and public access that would change the result.
- Check bucket versioning separately. Removing an object may leave versions;
  verify a policy for noncurrent versions and delete markers, and confirm the
  resulting physical retention in a test bucket. Immutable keys do not by
  themselves remove older versions or replicas.
- Confirm incomplete multipart uploads are eventually removed. COS lifecycle
  execution timing is not an exact per-object seven-day deletion guarantee.
  Measure the provider's actual deletion lag and include it in acceptance.
- Put a test label, confirm private access and authorized download, and verify
  its bytes disappear after the configured interval while metadata survives.

The worker deliberately skips STORING records because legacy uploads may still
be writing. Lifecycle cleanup covers their orphan bytes. Reconcile stale
STORING metadata in an operator-reviewed procedure after confirming the upload
is no longer active; do not blindly mark all STORING rows failed. Local
filesystem storage has no COS lifecycle fallback: it needs an independently
reviewed orphan-file cleanup process. A successful unit test does not establish
physical retention compliance for either backend.

## Two-year metadata maintenance command

`src/scripts/purgeExpiredIntegrationData.ts` builds to
`dist/scripts/purgeExpiredIntegrationData.js`. It defaults to a SELECT-only
preview and requires one `--client-id` UUID in both modes. It has no scheduler
registration and does not use the business API's database credentials or Redis.

```sh
# Preview up to 100 eligible rows in each category; prints counts only.
node dist/scripts/purgeExpiredIntegrationData.js --client-id 11111111-1111-4111-8111-111111111111

# Explicitly execute the reviewed scope, at most 100 per category per run.
node dist/scripts/purgeExpiredIntegrationData.js --client-id 11111111-1111-4111-8111-111111111111 --batch-size 100 --execute
```

Supply `RETENTION_MYSQL_HOST`, `RETENTION_MYSQL_DATABASE`,
`RETENTION_MYSQL_USER`, `RETENTION_MYSQL_PASSWORD`, and optionally
`RETENTION_MYSQL_PORT` (3306 by default) through the maintenance environment.
No credential values belong in command arguments, logs, or this runbook.
Use a dedicated maintenance principal: SELECT on the tables below, DELETE on
the integration tables being purged, and UPDATE on `shipments` and
`air_pickup_orders`. The normal API principal intentionally lacks DELETE.
Provisioning this principal is an operator action; this implementation changes
no users or grants and has not connected to a live database.

The database clock determines a cutoff of `CURRENT_TIMESTAMP(3) - INTERVAL 2
YEAR`. Shipment creation/update and every related event, print, inbound,
callback, and label timestamp must be strictly older than that cutoff. Every
label must already have `bytes_deleted_at`, and that timestamp must also be
older than the cutoff. This deliberately preserves audit metadata for two
years after the last retention activity, including PDF deletion. Any
undelivered callback, incomplete attempt/message, STORING asset, or recent
child prevents shipment deletion. Because batch messages have no shipment FK,
recent or incomplete `inbound-batches.upsert` messages are linked through the
shipment's air-pickup order and their trimmed JSON `batchId` using the order's database
collation. Messages for that batch block its shipment purges; unrelated batches
for the same client do not. Malformed cross-shipment current-label pointers also block
purging to prevent indirect changes to another shipment.

Execution locks the shipment first and rechecks its children using locking
reads inside the transaction. TYG label versions are included: any version
whose `created_at` is within two years blocks shipment deletion, even if the
shipment and label asset themselves are older. Version tenant scope is derived
from the owning shipment because `tyg_label_versions` has no `client_id`.
The maintenance principal also needs SELECT and DELETE on this table.
Dependency order is webhook attempts, webhook
events, print attempts, print logs, shipment events, delivery changes, and
inbound messages, and TYG label versions; then it clears the current-label pointer and deletes label
assets and the shipment. No foreign-key checks are disabled. Each shipment
commits separately. A failure rolls back the current shipment and stops the
run; earlier committed shipments remain deleted and a rerun resumes naturally.
Counts in a preview are bounded candidate counts, not a full-table census or
a guarantee that concurrent changes will remain eligible during execution.

Separate bounded steps delete only the same client's unassociated inbound
messages whose received/completed timestamps are older than two years and
whose state is COMPLETED. The order step clears only `raw_data` on this
client's UPSTREAM air-pickup orders older than two years with no remaining
referencing shipments. It retains the operational order, receipt evidence,
and its original `updated_at`; manual orders are untouched. Staging migrations
014 and 015 add customer-profile and pickup-document foreign keys, respectively.
These refer to the customer/operational order records retained here; no
customer profiles, profile events, pickup documents, or receipts are deleted.
Category limits
default to 100 and accept 1–1000, so one call may process up to three times
the limit across categories. Related child counts are not individually capped;
measure unusually large shipment histories before execution.

The application module is
`createMetadataRetention({ mysql }).run({ clientId, execute: false, batchSize: 100 })`.
Its report contains only dry-run mode and candidate/deleted/skipped counts.
Archive the reviewed scope, aggregate result, time, and operator identity in
the maintenance audit. Repeat preview/execute for the same client until no
eligible rows remain. Coordinate with busy ingestion periods; deadlocks fail
and roll back safely and can be retried. Preserve warehouse cursor/reset
procedures when deleting old delivery history. Holds are not modeled in this
schema: do not execute for a client with a retention hold until its scope has
been resolved. Backups, replicas, exports, warehouse records, and independent
financial/audit retention remain separate operator responsibilities.

## Acceptance checks

On real MySQL/COS test infrastructure, race expiry against identical-content
renewal and different-content replacement. Confirm the new object/pointer
survives, only one worker owns the lock, deletion outages preserve metadata,
and restarting after a successful remove but failed DB commit is safe. Check
expired download/print rejection independently of scheduler health. Run the
high-volume expiry backlog test with realistic COS latency before choosing
the production schedule. No production configuration changes are included here.
