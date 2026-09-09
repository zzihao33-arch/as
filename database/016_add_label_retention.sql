-- Private PDF bytes expire after seven days. Metadata is retained separately.
-- Apply once after migration 015 on MySQL 8.0.13+, before updated API processes start.
USE cmhub;

ALTER TABLE label_assets
  ADD COLUMN expires_at DATETIME(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3) + INTERVAL 7 DAY) AFTER ready_at,
  ADD COLUMN bytes_deleted_at DATETIME(3) NULL AFTER expires_at,
  ADD KEY idx_label_assets_expiry_cleanup (bytes_deleted_at, expires_at);

-- Also cover failed/stale uploads that already have an object. STORING rows are
-- excluded by the worker; reconcile abandoned uploads operationally/lifecycle.
-- The non-NULL expression default also covers old writers that insert during
-- rolling deployment after this backfill. Updated writers provide explicit expiry.
UPDATE label_assets
SET expires_at = COALESCE(retention_expires_at, DATE_ADD(COALESCE(ready_at, created_at), INTERVAL 7 DAY));
