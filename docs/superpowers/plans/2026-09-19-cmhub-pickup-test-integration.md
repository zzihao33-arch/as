# CM-HUB Employee Pickup Document Test Integration Plan

> **For agentic workers:** Execute this plan task by task. Test environment changes require a final preflight and a concrete rollback point.

**Goal:** Integrate the isolated document checker candidate with the current CM-HUB test release line and verify real private upload, authorized read/download, and permission revocation while keeping production disabled.

**Architecture:** The integration branch starts at `origin/staging` and cherry-picks the candidate into an isolated worktree. The test release line already uses migration 015 for legacy pickup documents, so preserve its table and downloads; migrations 017/018 add the operation-ledger fields and checker-backed v2 table. Verify the test host, backend revision, migration ledger, object-storage test prefix, and deployment workflow before changing remote state. Use only synthetic test orders and documents.

**Tech Stack:** Node.js 22, Express, TypeScript, MySQL, PM2, Tencent Cloud CVM command console, isolated Docker document checker.

**Spec:** `docs/CM-HUB-v1-scope-freeze-2026-09-18.md`; `docs/CM-HUB-pickup-v1-candidate-2026-09-19.md`.

## Global Constraints

- Production `PICKUP_DOCUMENTS_ENABLED=false`.
- Test database must be `tyg_integration_test`; object storage prefix must be `test`.
- Only synthetic user accounts, orders, and document bytes may be used.
- Do not overwrite unrelated API or push-log work; deploy only from the controlled test release path.
- Apply only checksum-verified migrations 017/018 after the release-line schema is inspected; do not overwrite or remove migration 015 assets.
- Legacy `.xls` remains unavailable and fails closed; Office preview and public driver entry remain out of scope.

---

### Task 1: Establish a current test baseline

**Files:**
- Read: `docs/deployment/test-environment.md`
- Read: `deploy/ubuntu/deploy-test-api.sh`
- Read: `database/017_add_warehouse_ui_operations.sql`
- Read: `database/018_add_pickup_documents.sql`

- [x] Confirm the host identity and health endpoint; the prior thread verified `tyg-api-test / ins-nm8jebfh` and HTTP 200.
- [x] Confirm test-only environment guards and deploy ordering in the script; the TAT read-only command verified the test database connection and environment assertions, then stopped at Git's dubious-ownership guard before outputting the ledger.
- [x] Confirm migration application through the successful test workflow (`npm run migrate`); the deploy script checks the exact immutable checker image before entering that step.
- [ ] Stop if production resources, unexplained server changes, migration drift, or an unsafe rollback point is found.

### Task 2: Verify a reviewable deployment candidate

**Files:**
- Integration branch `codex/cmhub-pickup-test-integration`
- Test release workflow and deployment scripts

- [x] Run frontend/backend tests, strict type checks, and builds; frontend 48/48, backend 147/147, and 18 migration files validate.
- [x] Verify the integration diff against `origin/staging`, preserving release-line changes and legacy assets.
- [ ] Prepare rollback to the exact running test revision and preserve the test `.env` and schema state.
- [x] Deploy the authorized integration release to `tyg-api-test / ins-nm8jebfh` through the existing `staging` workflow; run 35454325794 succeeded and public health returned `ok: true`.

The GitHub workflow only deploys pushes to `staging`; the test workflow now explicitly enables documents with the previously accepted immutable checker digest. The server-side deploy script requires that exact flag and digest and checks that the image is available to the deployment runtime before migrations. A manual dispatch from this feature branch still pulls the existing `staging` tip. Push the reviewed commits to `staging` only after the read-only host and migration preflight succeeds.

### Task 3: Exercise the end-to-end test flow

**Files:**
- Existing synthetic acceptance artifacts under `docs/operations/cmhub-checker-acceptance-2026-09-19/`

- [x] Verify post-deploy public health; workflow success confirms the immutable checker image guard and migration step passed.
- [x] Apply migrations through the checksum-aware migration runner against the guarded `tyg_integration_test` database.
- [ ] With synthetic data, verify upload, checker verdict, private authorized read, original download, and PDF/image view. Blocked pending an available test login or agreement on a least-privilege synthetic account.
- [ ] Verify malicious, corrupted, encrypted, and disguised inputs fail closed; verify permission revocation denies reads and writes; verify the disabled feature flag avoids document database access.
- [ ] Record redacted request IDs, outcomes, migration state, deployment revision, and rollback evidence.

### Task 4: Close the test stage

- [ ] Restore the previous test deployment if a check fails; retain additive schema only when rollback compatibility is verified.
- [ ] Confirm no synthetic test records or checker containers remain, and test API health is normal.
- [ ] Update the continuation record with verified evidence and remaining gaps.
- [ ] Keep production disabled until all release gates and an explicit production rollout are reviewed.
