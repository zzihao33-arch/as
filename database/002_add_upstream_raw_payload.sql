-- CM-HUB: retain the complete upstream order payload and extract print-critical fields.
-- Apply once after 001_create_logistics_api_schema.sql on MySQL 8.0.

USE cmhub;

ALTER TABLE shipments
  ADD COLUMN order_id VARCHAR(128) NULL AFTER client_id,
  ADD COLUMN recipient_name VARCHAR(128) NULL AFTER label_sha256,
  ADD COLUMN recipient_phone VARCHAR(64) NULL AFTER recipient_name,
  ADD COLUMN recipient_address JSON NULL AFTER recipient_phone,
  ADD COLUMN items JSON NULL AFTER recipient_address,
  ADD COLUMN raw_data JSON NULL AFTER items,
  ADD KEY idx_shipments_client_order (client_id, order_id);

-- Rows created before this migration have no upstream payload snapshot.
-- Preserve that history with an empty object, then require all later writes to include a payload.
UPDATE shipments
SET raw_data = JSON_OBJECT()
WHERE raw_data IS NULL;

ALTER TABLE shipments
  MODIFY COLUMN raw_data JSON NOT NULL;
