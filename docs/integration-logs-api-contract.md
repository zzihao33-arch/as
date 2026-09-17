# Customer push audit API

All routes are under `/warehouse/v1/integration-logs`, use the existing warehouse session cookie, origin boundary and `integration_logs.view` permission. This is an explicitly global administrative capability, including unattributed authentication failures; no warehouse selection is required. Roles may configure it through the existing permission catalog. Initial migration assigns it to roles already holding both `accounts.manage` and `roles.manage`; system administrators receive the catalog automatically.

Success envelope: `{ data: ..., requestId: string }`. Errors use existing `{ error: { code, message, requestId } }`. IDs/cursors are canonical unsigned decimal **strings**, never JavaScript numbers. All timestamps are UTC ISO strings.

## GET `/`

Query: `page` (1–10000, default 1), `pageSize` (1–100, default 20), `clientId` (UUID or `unknown`), `operation` (`shipment`, `inbound_batch`, `air_shipment`, `label_push`, `label_pdf`), `status` (`success` or `failure`), `from` and `to` (UTC ISO timestamps, inclusive), `search` (max 128 characters, literal substring of request ID or business reference). Unknown query keys are ignored; invalid known filters return 400.

`data = { records: LogRecord[], total: number, page, pageSize, cursor: string, metrics: { total, success, failure }, clients: { id, name, code }[] }`.

Metrics and total cover the full filtered result at the returned cursor, not just the page. Clients are the available integration clients, sorted by name (up to 1000). Records sort newest audit ID first. No historical attempts are synthesized.

`LogRecord = { id: string, occurredAt: string, completedAt: string, requestId: string, clientId: string|null, clientName: string|null, operation: string, method: string, endpoint: string, reference: string|null, httpStatus: number, outcome: 'success'|'failure', durationMs: number, errorCode: string|null }`.

## GET `/:id`

`data = LogRecord & { requestSummary: object, responseSummary: object }`. Missing ID returns 404. Summaries contain only allowlisted structural metadata: body format, item counts, PDF omission flag, content length, HTTP status and machine error code. No credentials, headers, response message text, PDFs/base64, recipient addresses, contact data or full raw bodies are retained. References/request IDs are bounded operational identifiers and must never be used to carry secrets. Endpoint is a route template, not the raw URL or query string.

## GET `/notifications`

`data = { cursor: string, readCursor: string, unreadCount: number }`. The snapshot records the greatest cursor observed by this account. Unread counts are global and unfiltered. Calling this endpoint does not mark anything read. Poll only with permission. On the first successful poll establish a baseline silently; only later advances may notify. Stop/reset polling and ignore stale responses on account change. Sound is coalesced in the frontend over 15 seconds and requires user gesture unlock.

## POST `/read`

JSON `{ cursor: string }`. `data = { readCursor: string }`. Acknowledges at most the greatest cursor previously returned to this account by list/notifications. The watermark only increases, across concurrent tabs and devices. Future cursors are clamped to the observed cursor; malformed cursors return 400. The frontend should fetch the list on entry and submit its cursor **once**, not acknowledge each poll or refresh; subsequent arrivals stay unread. Detail reads do not acknowledge.

## Durability and ordering

Each completed supported inbound mutation creates a separate attempt, even for an idempotency replay or duplicate request ID. Middleware runs before parsers/auth and records normal responses, parser errors, authentication/scope/rate-limit failures and unexpected errors. Audit persistence runs independently after response completion, outside ingestion transactions. A short singleton allocator transaction serializes ID allocation through commit, so later visible IDs cannot hide a lower uncommitted ID. The observed watermark never uses an auto-increment high-water mark. Storage failure is fail-open with a bounded diagnostic; this is a best-effort audit (process termination/storage failure may lose attempts), not a transactional receipt. No audit failure changes the ingestion response. Graceful shutdown drains pending writes.
