-- Apply after 016, before starting API/worker code that compares UTC expiry.
-- Explicit expires_at values already use JS UTC Date through mysql2 timezone Z.
-- Omitted values must use the same clock, regardless of the DB session zone.
-- Business/audit timestamps retain their existing session-local semantics.
--
-- This changes only the default; it deliberately does not rewrite existing rows.
-- Before enabling cleanup on a populated database, audit each expiry's source:
-- 016 preserved legacy retention_expires_at, but its ready_at/created_at fallback
-- and omitted-value default used session-local time. Other writers used UTC.
-- A uniform offset cannot safely repair this mixed provenance. Confirm legacy
-- session zones and row history, then review any targeted repair separately.
-- An empty label_assets table needs no historical data conversion.
USE cmhub;

ALTER TABLE label_assets
  ALTER COLUMN expires_at SET DEFAULT (UTC_TIMESTAMP(3) + INTERVAL 7 DAY);
