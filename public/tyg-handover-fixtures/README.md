# Fixed synthetic acceptance fixtures

Run / bill number: `TYGHO20260916AABD`. These files contain no user photos or real shipment information. Do not print or ship.

- `synthetic-80000.pdf` is copied byte-for-byte from the existing validated `docs/operations/tyg-release-preflight-2026-09-15/fixtures/synthetic-80000.pdf`. SHA-256: `76551f9d4286b52d33b00abc25d8d57e81fe3ad6c390a53a541da57732b86fad`.
- The five PNGs were drawn locally with Windows System.Drawing: 1000 × 800 pixels, visible synthetic/run/type labels, distinct colors and rectangular patterns. No external images were used.
- `manifest.json` records each file's byte length and SHA-256. The HTML independently pins the same expected values. Total fixture size: 184388 bytes.

The acceptance HTML uses the HTTP contracts read from candidate `750e532a4e27eb19b4b6f99f97f358177e8f0c04`: `src/features/session/warehouseApi.ts`, `services/cloud-api/src/index.ts`, `customerProfiles.ts`, and `airPickupOperations.ts`. The customer uses `customerId`, receipt uses `/air-pickup-receipt-batches`, and evidence is uploaded via PUT with raw bytes and declared SHA-256.

Local verification: JavaScript parse; every fixture hash and size; PNG dimensions and decompression; offline mocked full flow (85 requests, 10 writes, 737552 asset transfer bytes); completed recovery (26 requests, no writes); wrong identity, unjournaled bill collision, pending-write blocking, and ambiguous-write failure with no retry. These are local harness checks, not a claim that the remote API acceptance has passed.

The HTML requires exact active customer code `TYG` and name `TYG`, the same Test Admin session throughout, and the production-shaped test API. Any mismatch stops. Do not clear a journal, change the bill number, or retry an uncertain mutation to bypass the stop.

## One bounded CORS reconciliation

The first real run created the fixed order, document, and receipt batch, then stopped with receipt upload request 21 PENDING / `Failed to fetch`. Candidate `750e532` and operator-inspected actual OPTIONS 204 allow `X-Image-Sha256` but omit `X-Image-Quality-Warnings` and `X-Image-Quality-Override`. Both the original harness and old frontend `3d98a79` always sent those optional headers. The older backend also omitted them. Consequently this is also a preexisting product frontend cross-origin image-upload limitation; success of this harness does not prove old-frontend upload acceptance.

The revised harness omits those two headers for the synthetic images, preserving the existing API's defaults of no warnings and no override. No backend, permission, or session changes are involved.

The read-only reconciliation button only accepts the exact original journal, request sequence, pending timestamp, order `2a529567-8fe6-4d08-9aa4-a3c0d03f329f`, receipt batch `5f4bc2d0-4a19-4637-aa14-472c1286d6d1`, and document `6ea0c033-a065-4960-af75-2eb884c8be63`. Five GET requests verify identity, fixed inventory, absent receipt evidence and events, and PDF bytes. It archives the complete original journal in the same journal's `recovery.originalJournal`, then requires a separate visible recovery click. The receipt has at most one explicit recovery attempt; its old attempt remains under `archivedAttempts`. All IDs, bill number, original completed steps, request counters, and failure history are retained. Any new failure stops with no further retry.

Local recovery checks using a copy of the actual downloaded report: read-only reconciliation 5 GET / 0 writes; reload and explicit recovery 78 requests / 7 new writes, ending with 10 logical completed steps; exact original journal preserved. Existing receipt evidence stopped with 0 writes. A simulated second network failure retained PENDING; another attempted recovery made 0 requests. These remain offline checks, not remote acceptance results.
