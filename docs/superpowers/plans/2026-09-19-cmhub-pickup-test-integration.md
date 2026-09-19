# CM-HUB Employee Pickup Document Test Integration Plan

> **For agentic workers:** Execute this plan task by task. Test environment changes require a final preflight and a concrete rollback point.

**Goal:** Integrate the isolated document checker candidate with the dedicated CM-HUB test API and verify real private upload, authorized read/download, and permission revocation while keeping production disabled.

**Architecture:** Start from candidate commit `6f35d7c` in an isolated worktree. Verify the test host, backend revision, migration ledger, object-storage test prefix, and deployment workflow before changing remote state. Use only synthetic test orders and documents, and rely on additive migrations 014/016 after checksum and schema checks.

**Tech Stack:** Node.js 22, Express, TypeScript, MySQL, PM2, Tencent Cloud CVM command console, isolated Docker document checker.

**Spec:** `docs/CM-HUB-v1-scope-freeze-2026-09-18.md`; `docs/CM-HUB-pickup-v1-candidate-2026-09-19.md`.

## Global Constraints

- Production `PICKUP_DOCUMENTS_ENABLED=false`.
- Test database must be `tyg_integration_test`; object storage prefix must be `test`.
- Only synthetic user accounts, orders, and document bytes may be used.
- Do not overwrite unrelated API or push-log work; deploy only from the controlled test release path.
- Migration 014 is a dependency of 016; do not apply 013, 015, or 017 as part of this feature.
- Legacy `.xls` remains unavailable and fails closed; Office preview and public driver entry remain out of scope.

---

### Task 1: Establish a current test baseline

**Files:**
- Read: `docs/deployment/test-environment.md`
- Read: `deploy/ubuntu/deploy-test-api.sh`
- Read: `database/014_add_warehouse_ui_operations.sql`
- Read: `database/016_add_pickup_documents.sql`

- [ ] Confirm the host identity and health endpoint.
- [ ] Record the running commit, PM2 process path, working-tree state, test-only environment key names, migration filenames/checksums, and database ledger without printing secrets.
- [ ] Compare each pending migration checksum with the remote ledger and inspect existing columns/tables before any migration.
- [ ] Stop if production resources, unexplained server changes, migration drift, or an unsafe rollback point is found.

### Task 2: Verify a reviewable deployment candidate

**Files:**
- Candidate source at commit `6f35d7c`
- Test release workflow and deployment scripts

- [ ] Run the candidate backend test suite, strict type check, and build.
- [ ] Verify its exact diff against the deployed test API and release branch, preserving unrelated endpoint and push-log changes.
- [ ] Prepare a rollback to the exact previously deployed commit and preserve the test .env and schema state.
- [ ] Deploy the exact candidate only after the user authorizes transmitting it to `tyg-api-test / ins-nm8jebfh`.

### Task 3: Exercise the end-to-end test flow

**Files:**
- Existing synthetic acceptance artifacts under `docs/operations/cmhub-checker-acceptance-2026-09-19/`

- [ ] Verify post-deploy health and the immutable checker image configuration.
- [ ] Apply only checksum-verified pending migrations 014/016 against the test database.
- [ ] With synthetic data, verify upload, checker verdict, private authorized read, original download, and PDF/image view.
- [ ] Verify malicious, corrupted, encrypted, and disguised inputs fail closed; verify permission revocation denies reads and writes; verify the disabled feature flag avoids document database access.
- [ ] Record redacted request IDs, outcomes, migration state, deployment revision, and rollback evidence.

### Task 4: Close the test stage

- [ ] Restore the previous test deployment if a check fails; retain additive schema only when rollback compatibility is verified.
- [ ] Confirm no synthetic test records or checker containers remain, and test API health is normal.
- [ ] Update the continuation record with verified evidence and remaining gaps.
- [ ] Keep production disabled until all release gates and an explicit production rollout are reviewed.
