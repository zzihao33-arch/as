# TYG confirmed API implementation plan

> **For agentic workers:** Use executing-plans for the connected ingestion changes and subagent-driven-development for independent retention and verification work. Track progress with the checkboxes below.

**Goal:** Implement the TYG requirements confirmed by the user on 2026-09-09, building on the existing upstream API.

**Architecture:** Keep the existing API-key-protected batch and single-shipment endpoints. Accept `labelPdfBase64` with the original and courier tracking numbers, validate the complete request, stage private immutable PDFs, and publish their asset pointers together with shipment changes and the durable idempotent response in one MySQL transaction. Empty batch shipments allow a forecast to arrive before labels. Preserve legacy metadata/PDF routes for existing consumers.

**Tech Stack:** TypeScript, Express, MySQL 8, Redis, private Tencent COS, node:test.

**Spec:** User-confirmed sections 2 and 9 of `C:/Users/ZIHAO ZHANG/Desktop/CM-HUB-TYG-工作总结与当前进度-2026-09-01.docx`.

## Global constraints

- Label business fields: `firstLegTrackingNo`, `courierTrackingNo`, `labelPdfBase64`.
- Forecast: bill number, cartons, packages, weight, and weight unit; existing batch identifier and envelope retain context.
- Both metadata and PDF must be durably saved before HTTP success.
- Same original number updates the courier number and replaces the current PDF; closed/received/handed-over states do not reject supplementary labels.
- PDF bytes remain in private storage for 7 days; metadata and required audit records remain for 2 years. Never persist inline PDF bytes in raw JSON/audit data.
- Tens of thousands of records within 10 minutes is a test-environment acceptance target, not a claim that unit tests can establish.
- Do not deploy, modify cloud resources, commit unrelated user changes, or touch credentials. Existing frontend changes remain in place.

## Tasks

### 1. Unified ingestion and replacement

Files: `services/cloud-api/src/{labelPdf,shipmentInput,shipmentIngest,inboundBatchIngest,index}.ts`, new `inlineLabels.ts`, corresponding tests and test runner.

- [x] Add failing tests for Base64 decoding, invalid/oversize payloads, mandatory courier number for inline labels, and no Base64 in raw data.
- [x] Implement parsing and server-derived SHA-256, limited to 20 MiB per decoded PDF and 32 MiB per authenticated JSON request.
- [x] Add tests showing no success/DB publication before private storage succeeds, both single and batch paths; permit empty shipments for forecast-only batches.
- [x] Stage PDFs with bounded concurrency before opening the transaction; associate each PDF inside the same transaction as the shipment and response. A failed transaction leaves only unreferenced private objects, removable by the 7-day lifecycle.
- [x] Serialize updates through shipment row locks. Keep old active PDF until the transaction commits. Preserve tenant and batch conflict checks and existing idempotent replay rules.

```ts
assert.equal(parseShipmentUpsert({ firstLegTrackingNo: 'A', courierTrackingNo: 'B', labelPdfBase64: pdf.toString('base64') }).labelPdf?.byteSize, pdf.length);
await assert.rejects(ingestor.ingest(request), { code: 'LABEL_STORAGE_UNAVAILABLE' });
assert.equal(transactionStarted, false);
```

### 2. Retention and expiry

Files: new migration `016_add_label_retention.sql`, new `labelRetention.ts`, tests, runbook; controller integrates expiry filters and scheduled calls into existing readers/server.

- [x] Add expiry timestamps and tests for expired downloads, current pointer invalidation, safe retry after object deletion failure, and retained metadata.
- [x] Apply a seven-day expiry to accepted uploads. Clear expired active pointers and publish delivery changes, then remove bytes while keeping audit metadata.
- [x] Document read-only COS lifecycle verification and supply a scoped two-year metadata maintenance command with a SELECT-only default preview; record the required maintenance credentials and deployment prerequisites.

### 3. Contract, load verification, and final review

Files: `docs/api/clients/TYG-API-v1.1-已确认待联调.md`, example payload, test-only load script, env/reverse proxy configuration.

- [x] Document exact request envelopes, separate forecasting, retries, replacements, limits, and retention. Keep the existing v1 document marked as legacy; no final production PDF before bilateral acceptance.
- [x] Provide a bounded load probe restricted to explicitly specified test hosts; report successes, errors, elapsed time and throughput with no credentials or PDFs in output.
- [x] Run backend typecheck, complete node tests, migration parser checks, and build. Inspect final diff and review transactional failure/concurrency paths.
- [x] Record remaining external acceptance checks: live MySQL/COS migration/lifecycle, realistic 10-minute load test, TYG end-to-end acceptance.

## Progress

- Baseline: local master at `3d98a79`, user frontend changes pre-exist. Created branch `codex/tyg-confirmed-api` without altering those files.
- Dependency setup: installed locked backend dependencies after the sandbox blocked registry access.
- Implementation proceeds in the existing checkout on the feature branch; no publishing or cloud changes are authorized by this development request.

- Completed unified inline-PDF ingestion, forecast-only batches, immutable replacement, expiry-aware readers, seven-day worker, and two-year scoped maintenance tooling.
- Independent review fixes: separate legacy/inline idempotency hashes; non-NULL expiry defaults during rollout; qualify joined metadata timestamps and normalize batch IDs in cleanup guards.
- Final local verification: 113 tests passed, zero failed; 13 migration parser checks passed; backend typecheck and production build passed; git diff --check passed.
- External acceptance remains pending: actual MySQL migration/concurrency behavior, private COS lifecycle/deletion behavior, representative ten-minute load, and bilateral TYG integration. No deployment, live purge, push, or commit performed.
