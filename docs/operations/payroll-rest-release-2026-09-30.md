# Payroll rest rules release — 2026-09-30

Status: prepared and locally verified; production deployment has NOT run. Tencent Cloud console requires the user to restore the existing login session.

## Scope

Daily unpaid break windows default to 12:00–13:00 America/New_York, with warehouse defaults and employee overrides effective by date. Only actual attendance overlap is deducted. Excel contains the original summary and daily punch, break, payable-hour, regular/OT wage details; incomplete punches block saved runs and exports. Existing payroll snapshots are retained.

## Separate release baselines

- UI base: 51a2aeaea3c4f46c49c54df61a8c2c9f27c60ef9; branch codex/payroll-rest-release.
- API base: c55e76743b8134de2306686be5cae25bff8c4ffd; branch codex/payroll-rest-api.
- Current frontend production: dpl_8ZWmDBGbrmfXjvPBLVq57NTAuab7, READY and production per Vercel connector. Keep this rollback candidate.
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
