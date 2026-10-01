# Payroll rest rules release — 2026-09-30

Status: DEPLOYED and production-verified on 2026-09-30 (America/New_York).

## Scope

Daily unpaid break windows default to 12:00–13:00 America/New_York, with warehouse defaults and employee overrides effective by date. Only actual attendance overlap is deducted. Excel contains the original summary and daily punch, break, payable-hour, regular/OT wage details; incomplete punches block saved runs and exports. Existing payroll snapshots are retained.

## Separate release baselines

- UI base: 51a2aeaea3c4f46c49c54df61a8c2c9f27c60ef9; branch codex/payroll-rest-release.
- API base: c55e76743b8134de2306686be5cae25bff8c4ffd; branch codex/payroll-rest-api.
- Previous frontend production: dpl_8ZWmDBGbrmfXjvPBLVq57NTAuab7, READY and production per Vercel connector. Keep this rollback candidate.
- Server expected instance ins-dmx8z3xt, application /www/wwwroot/releases/cloud-api-b1c897a-20260920T170700Z. Live process/files must still pass the release script preflight.
- Do not deploy the root checkout or merge the frontend branch's old server wholesale into production.

## Verification

API: 236 tests passed, 22 portable migrations checked, TypeScript test typecheck and production build passed.
UI: 55 tests passed including XLSX roundtrip and current scanner regressions; strict typecheck and production build passed. Existing Vite bundle-size advisory remains.
Independent release-diff review found no P1/P2. Backend baseline compilation was reproduced and matched all guarded compiled-file hashes.

## Deployment order

1. Restore Tencent Cloud session; inspect live app and schema read-only.
2. Copy deploy/apply-payroll-rest-patch.mjs and deploy/payroll-rest-patch.json from the API branch to the intended production server. Run the script without --apply first. It enforces the exact instance, process path, health, existing file hashes and payload hashes.
3. Supply the existing DBA password locally without logging it, then run with --apply. Only migration 022 and the eight source/compiled payroll API files are targeted. A private backup is created first. The script checks runtime SELECT/INSERT/UPDATE permissions; if the existing runtime account uses table-scoped grants, grant only the necessary existing application access on the new table before retrying. A partially applied unrecorded migration requires explicit inspection, not a blind retry.
4. Verify runtime route authentication and health. Code failures restore original files and reload the service; additive schema is retained. Record actual backup path and deployment evidence here.
5. Push the UI commit to master only after backend success. Wait for Vercel READY and confirm production alias. Test authenticated rule loading, payroll calculation and XLSX export in the production UI without creating fabricated payroll records or changing actual employee rules.

No live payroll data or production setting was changed while preparing this release.

## Completed production release

- API release commit: 57269714bffbab6f686d0df45e887dce8f5ed392. Tencent preflight command cmd-6cgda5h4 / invocation inv-w9brsfgfxq passed at 23:10:24–25. All existing source/compiled hashes matched; schema ledger contained migrations 001–021.
- Apply command cmd-f0f4k3a0 / invocation inv-w9brukgisr succeeded at 23:12:41–45, exit 0. Migration 022 recorded and runtime table-scoped SELECT/INSERT/UPDATE grants verified. PAYROLL_SCHEMA_AND_RUNTIME_ACCESS=PASS and PAYROLL_DEPLOY=PASS. No credentials are included in release evidence.
- Actual code backup: /root/payroll-rest-backup-Zehrin. Release staging: /root/payroll-rest-5726971. Health passed and the unauthenticated new rule route returned 401. Additive schema is retained on code rollback.
- Frontend commit 9b2eb983c4956a2e371fd6cef43f6a086b77cd87 was fast-forwarded to master after API success. Vercel production dpl_D28WhL611pXRt55Dd3Zn6ABz5PuC reached READY; cmhubtool.com and www.cmhubtool.com aliases confirmed. Previous deployment above remains the frontend rollback candidate.
- Authenticated production UI loaded warehouse-default and employee rule editors, both showing the default 12:00–13:00. Both dialogs were canceled; no actual employee break settings were modified.
- The normal September 1–30 payroll export was executed once, creating a saved payroll snapshot and downloading the workbook at 23:15:20. This is a payroll calculation/export, not a payment.
- Read-only workbook verification: two worksheets, 9 employees, 270 employee/date detail rows, 80 attendance days. All 9 employees' daily regular/OT hours and wages reconcile with summary; net-hour and daily wage splits pass. One attendance day deducts zero break and five deduct partial breaks. No reconciliation errors. Blank dates remain explicit no-record rows.
- Workbook artifact: C:/Users/ZIHAO ZHANG/Downloads/2026年9月_员工考勤及工时统计表 (2).xlsx. XLSX values verified; optional artifact-tool image rendering did not complete, so no claim is made about a rendered workbook preview.
