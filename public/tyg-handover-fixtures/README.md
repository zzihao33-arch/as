# Fixed synthetic acceptance fixtures

Run / bill number: `TYGHO20260916AABD`. These files contain no user photos or real shipment information. Do not print or ship.

- `synthetic-80000.pdf` is copied byte-for-byte from the existing validated `docs/operations/tyg-release-preflight-2026-09-15/fixtures/synthetic-80000.pdf`. SHA-256: `76551f9d4286b52d33b00abc25d8d57e81fe3ad6c390a53a541da57732b86fad`.
- The five PNGs were drawn locally with Windows System.Drawing: 1000 × 800 pixels, visible synthetic/run/type labels, distinct colors and rectangular patterns. No external images were used.
- `manifest.json` records each file's byte length and SHA-256. The HTML independently pins the same expected values. Total fixture size: 184388 bytes.

The acceptance HTML uses the HTTP contracts read from candidate `750e532a4e27eb19b4b6f99f97f358177e8f0c04`: `src/features/session/warehouseApi.ts`, `services/cloud-api/src/index.ts`, `customerProfiles.ts`, and `airPickupOperations.ts`. The customer uses `customerId`, receipt uses `/air-pickup-receipt-batches`, and evidence is uploaded via PUT with raw bytes and declared SHA-256.

Local verification: JavaScript parse; every fixture hash and size; PNG dimensions and decompression; offline mocked full flow (85 requests, 10 writes, 737552 asset transfer bytes); completed recovery (26 requests, no writes); wrong identity, unjournaled bill collision, pending-write blocking, and ambiguous-write failure with no retry. These are local harness checks, not a claim that the remote API acceptance has passed.

The HTML requires exact active customer code `TYG` and name `TYG`, the same Test Admin session throughout, and the production-shaped test API. Any mismatch stops. Do not clear a journal, change the bill number, or retry an uncertain mutation to bypass the stop.
