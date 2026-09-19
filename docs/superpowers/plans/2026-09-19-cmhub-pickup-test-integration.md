# CM-HUB Employee Pickup Document Test Integration Plan

Goal: integrate the isolated checker with the authorized CM-HUB test release, validate private employee document upload/read/download and permission revocation, and leave production disabled.

Scope: `tyg-api-test / ins-nm8jebfh`, database `tyg_integration_test`, private COS prefix `test`, synthetic data only. Legacy 015 assets preserved. Office online preview/conversion and public driver entry remain deferred; legacy XLS fails closed.

## Task 1: Establish test baseline — complete

- [x] Verify exact host, test-only environment, migration ledger and source revision.
- [x] Preserve rollback dist/environment/ledger under `/var/backups/cmhub-pickup-20260919-2018` (0700; environment 0600).
- [x] Confirm no production resource or migration drift; preserve historical extra ledger entry.

## Task 2: Deploy a verified candidate — complete

- [x] Reproduce and fix malformed list pagination SQL, then UTC upload lease comparison, with SQL-engine regressions.
- [x] Backend 150/150 tests, 18 migration checks, typecheck and build; frontend 48/48 tests, strict typecheck and build.
- [x] Deploy backend `16caa30` via successful test workflow 35467818039.
- [x] Correct rootless runtime access and CPU controller delegation while retaining all container restrictions.
- [x] Deploy frontend `4cfb6c3`, including missing component styles and dialogs above the host drawer.

## Task 3: End-to-end acceptance — complete

- [x] Real employee API uploads PDF/PNG/DOCX/XLSX, scanner verdicts, hash-identical original downloads, PDF/PNG private previews, replay and deduplication.
- [x] Permission revocation denies list/download/upload, restoration permits download; anonymous read denied.
- [x] Corrupt/disguised/encrypted/active PDF and standard EICAR rejected; legacy XLS unavailable without saving; valid upload succeeds afterwards.
- [x] Disabled-feature regression refuses storage/database access through throwing dependencies.
- [x] Browser PNG decoding, unobscured modal, PDF 1/1 rendering, and native file selection/upload completion.

## Task 4: Close test stage — complete

- [x] Keep verified release; failed infrastructure change attempts were recovered before further work.
- [x] Remove this task's synthetic order/customer, 7 assets/COS objects, 22 registrations/operations; verify zero residual business records. Delete temporary accounts/roles; retain security audit.
- [x] Verify no checker containers remain and health returns 200 with outbound webhooks disabled.
- [x] Save concise continuation and detailed evidence; production unchanged and disabled.

Evidence: [Acceptance report](../../CM-HUB-pickup-acceptance-2026-09-19.md), including exact revisions, request IDs, rollback limits and cleanup results. Full host reboot and any production rollout are outside this completed test stage and require a separate release decision.
