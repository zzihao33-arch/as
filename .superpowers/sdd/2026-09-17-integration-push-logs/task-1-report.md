# Task 1 report: backend customer push logs

Status: implementation and local verification complete; real MySQL verification pending main agent execution of the standalone disposable-schema verifier. No cloud or production actions performed by this agent.

## Delivered

- `services/cloud-api/src/integrationLogs.ts`: supported inbound POST shipment/batch/air/label and PUT PDF attempts, middleware registered before parsing/authentication, failure-safe bounded allowlisted metadata and independent post-response audit writes. Repeated request IDs/idempotent attempts remain distinct. Known API key/Bearer/JWT patterns are suppressed even in identifier fields. No headers, payloads, PDFs/base64, customer addresses, response text or database error text are retained.
- `/warehouse/v1/integration-logs` list/detail/notifications/read router behind warehouse session and `integration_logs.view`; full filtered metrics and paging, canonical decimal string IDs/cursors, ISO UTC timestamps. Query bindings include literal LIKE escaping and strict filter limits/calendar dates.
- `database/018_add_integration_push_logs.sql`: additive tables inheriting schema collation, JSON storage bounds, singleton sequence, account observed/read state, catalog permission and capability-based initial grants to roles holding both `accounts.manage` and `roles.manage`. System admin receives existing catalog automatically. Global visibility is intentional and documented.
- `docs/integration-logs-api-contract.md` published before implementation and sent to main agent for frontend integration.
- Verified API-key identity assigned before rate limiter, preserving attribution for 429/503 without changing auth or rate limits.
- `services/cloud-api/scripts/verifyIntegrationLogs.mjs`: real SQL verifier for isolated schema on MySQL 8.0.45. See below.

## Cursor/transaction invariants

Every append uses a fresh pool connection and its own transaction after response completion. Updating the singleton sequence obtains an InnoDB row lock held through the log INSERT and commit. A subsequent writer cannot allocate its ID before the earlier one commits/rolls back. Notifications read MAX(committed log id) and unread count in one statement snapshot. No auto-increment allocation watermark is used. Failed writes destroy the connection, rolling back the sequence and releasing locks. Missing allocator rows fail visibly rather than silently committing no log.

Observation upserts use GREATEST; acknowledgement uses GREATEST(current read, LEAST(requested, observed)). Reads are keyed only by authenticated userId. List metrics/rows are bounded by the returned committed snapshot cursor, so arrivals during queries remain unread after entry acknowledgement.

## TDD and local evidence

1. `node --import tsx --test test/integrationLogs.test.ts`: first red phase 0/6 tests passing against explicit not-implemented entrypoints, then 6/6 green after implementation.
2. `npm test`: auth attribution regression red: expected verified client on 429, got undefined; then green after assignment moved immediately after credential verification.
3. `node scripts/testMigrations.mjs`: red 17 != 18 before additive migration, then 18 portable migrations validated.
4. Added red regressions for real batchId/shipments metadata and missing allocator row: null reference vs BATCH-1; missing expected rejection. Both green after fixes.
5. Invalid calendar filter regression failed instead of returning 400, then passed after canonical date validation.
6. Added runtime HTTP capacity coverage: stalled audit writes drop excess requests with bounded diagnostics while every ingestion response remains 201.
7. Final commands from `services/cloud-api`: `npm test`, `npm run typecheck`, `npm run build`, `node --check scripts/verifyIntegrationLogs.mjs`. Results: **204 tests passed, 0 failed; 18 portable migrations validated; typecheck/build/verifier syntax exit 0**. `git diff --check` clean apart from normal line-ending warnings.

HTTP tests use a listening Express server and fetch; they exercise middleware/parser failures, 401/403/429/500, 413, duplicate request IDs, PDF omission, root and legacy error envelopes, denied route storage access, and failure-open writes. Query tests execute production query-building against dependency recorders and assert parameter binding, snapshot IDs above Number.MAX_SAFE_INTEGER, bounded inputs and acknowledgement SQL. Full MySQL concurrency/grants behavior is deliberately not claimed from those dependency tests.

## Real MySQL verifier (pending main agent)

Run `node services/cloud-api/scripts/verifyIntegrationLogs.mjs` after backend build. Requires `INTEGRATION_TEST_MYSQL_HOST`, optional `INTEGRATION_TEST_MYSQL_PORT`, `INTEGRATION_TEST_MYSQL_USER`, `INTEGRATION_TEST_MYSQL_PASSWORD`, and `INTEGRATION_TEST_ALLOW_DISPOSABLE_SCHEMA=yes`. Set `INTEGRATION_TEST_VERIFY_GRANTS=yes` to verify restricted application grants using a temporary account.

The verifier creates a random `integration_logs_test_<hex>` database with utf8mb4_0900_ai_ci, applies 018 against minimal fixture identity/client tables, then exercises delayed first commit vs second writer, invisible unfinished IDs, failed INSERT and oversize-summary rollback, per-account observed clamping, concurrent monotonic acknowledgements, account isolation, prepared list/detail filters/metrics/timezones/LIKE escaping, capability role seeding and optional precise grants. It drops the temporary schema/account in finally. It never writes business schemas or reads live business records. Main agent will retain actual MySQL evidence and handle fixes if needed.

## Exact production application grants

The existing migration runner skips GRANT statements. DBA must separately execute:

```sql
GRANT SELECT, INSERT ON cmhub.integration_push_logs TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, UPDATE ON cmhub.integration_push_log_sequence TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.integration_push_log_reads TO 'cmhub_api'@'127.0.0.1';
```

Existing SELECT on clients is used for client names/options. No new grants on business/identity tables are required by runtime. Schema/permission inserts run as the migration owner. No FLUSH PRIVILEGES needed for GRANT.

## Risks and limitations

- Audit is best effort: process termination, database outage, or the 256-pending-write capacity limit can lose attempts. Responses are never rewritten to pretend ingestion failed. Events `integration_audit_write_failed`, `integration_audit_queue_full`, `integration_audit_capture_failed` contain no secrets. Graceful shutdown drains writes. There is no fabricated historical backfill.
- Superseded by the review correction below: audit writes now have a dedicated single-connection pool and a whole-operation deadline; they cannot occupy business-pool connections.
- No automatic log retention policy is introduced. Historical growth needs monitoring; notification counts and filtered metrics require reads over relevant log history. Ordinary users cannot delete/update audit rows.
- Identifier fields must remain operational IDs; known credential patterns are scrubbed, but arbitrary secrets disguised as tracking references cannot be semantically recognized. All unstructured payload data is omitted.
- Real MySQL execution/grants/concurrency remains pending until main agent runs the supplied verifier. Local runtime tests alone do not prove MySQL DDL compatibility.

## Commit

This report belongs to the scoped backend implementation commit; exact SHA is returned to main agent after commit. No frontend/root package or unrelated workspace changes are included.

## Pre-release review corrections

Initial scoped commit: `6e94ee9`. Main-agent execution against real MySQL 8.0.45 exposed error 1064 because `cursor` was used as an unquoted alias. The alias is now backtick-quoted. The existing real SQL verifier is the definitive reproduction; the runtime query-boundary regression also confirms the emitted SQL quotes it. Full isolated MySQL rerun is pending the main agent.

Review reproduced 20 concurrent appends requesting 20 business-pool leases. Corrections: dedicated `integrationAuditMysql` pool, connectionLimit 1, waitForConnections false, connectTimeout 5000; shutdown closes it. The bounded middleware queue now has exactly one active writer and expires stale queued attempts. A five-second deadline includes queue delay, acquisition, BEGIN, both statements and COMMIT. Active connections are destroyed at timeout, late acquisitions are destroyed immediately, and guards after awaits prohibit late statements/commit. A COMMIT timeout is an uncertain result and is not retried. Tests stall each phase independently and assert timely rejection and connection destruction; runtime DB wiring tests verify isolation, capacity and shutdown.

TYG label push reference now uses originalTrackingNo; relatedReference preserves transferTrackingNo. The additive 018 migration includes a nullable indexed related_reference column (018 has not been applied to the business schema). Bounded sanitized airWaybillNo is retained in the allowlisted summary. Search covers both tracking numbers and air bill. The real SQL verifier now tests all three and additionally holds the allocator lock to confirm the independent audit deadline leaves the business pool available and allows a later append.

Red evidence: runtime tests failed on unquoted alias, air bill chosen instead of original tracking, 12 concurrent writers instead of 1, and acquisition never completing at deadline. Additional DB wiring regression failed five child-process checks for a missing isolated audit pool. Green: **207 backend tests, 18 migration checks, typecheck, build and verifier syntax pass**. No frontend files changed in this correction.
