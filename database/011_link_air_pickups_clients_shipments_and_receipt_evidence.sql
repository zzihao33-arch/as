-- CM-HUB: connect upstream clients, air-pickup forecasts, shipment mappings,
-- receipt evidence, and warehouse print progress into one business chain.
-- Apply once after 010_integrate_handover_document_permissions.sql on MySQL 8.0.

USE cmhub;

ALTER TABLE air_pickup_orders
  ADD COLUMN client_id CHAR(36) NULL AFTER id,
  ADD COLUMN client_name_snapshot VARCHAR(128) NOT NULL DEFAULT '未绑定客户' AFTER client_id,
  ADD COLUMN source_type ENUM('MANUAL', 'UPSTREAM') NOT NULL DEFAULT 'MANUAL' AFTER client_name_snapshot,
  ADD COLUMN external_batch_id VARCHAR(128) NULL AFTER source_type,
  ADD COLUMN raw_data JSON NULL AFTER external_batch_id,
  ADD UNIQUE KEY uq_air_pickup_client_external_batch (client_id, external_batch_id),
  ADD KEY idx_air_pickup_client_updated (client_id, updated_at DESC),
  ADD CONSTRAINT fk_air_pickup_orders_client FOREIGN KEY (client_id) REFERENCES clients(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE shipments
  ADD COLUMN air_pickup_order_id CHAR(36) NULL AFTER client_id,
  ADD KEY idx_shipments_air_pickup_status (air_pickup_order_id, status, updated_at DESC),
  ADD CONSTRAINT fk_shipments_air_pickup_order FOREIGN KEY (air_pickup_order_id) REFERENCES air_pickup_orders(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE TABLE air_receipt_evidence_assets (
  id CHAR(36) NOT NULL,
  receipt_batch_id CHAR(36) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  storage_key VARCHAR(768) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_type ENUM('image/jpeg', 'image/png') NOT NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  pixel_width INT UNSIGNED NOT NULL,
  pixel_height INT UNSIGNED NOT NULL,
  quality_warnings JSON NULL,
  quality_override BOOLEAN NOT NULL DEFAULT FALSE,
  asset_status ENUM('READY', 'REMOVED') NOT NULL DEFAULT 'READY',
  uploaded_by_user_id CHAR(36) NULL,
  uploaded_by_reference VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_air_receipt_evidence_content (receipt_batch_id, content_sha256),
  KEY idx_air_receipt_evidence_active (receipt_batch_id, asset_status, created_at),
  CONSTRAINT fk_air_receipt_evidence_batch FOREIGN KEY (receipt_batch_id) REFERENCES air_receipt_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_air_receipt_evidence_uploader FOREIGN KEY (uploaded_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (content_sha256 REGEXP '^[0-9a-f]{64}$'),
  CHECK (byte_size BETWEEN 1 AND 10485760),
  CHECK (pixel_width >= 800 AND pixel_height >= 600)
) ENGINE=InnoDB;

ALTER TABLE air_pickup_events
  MODIFY COLUMN event_type ENUM(
    'ORDER_RECORDED', 'ORDER_EDITED', 'ORDER_RECEIVED', 'ORDER_HANDED_OVER',
    'ORDER_VOIDED', 'HANDOVER_DRAFT_CREATED', 'EVIDENCE_ADDED', 'EVIDENCE_REMOVED',
    'ORDER_CORRECTED', 'RECEIPT_EVIDENCE_ADDED'
  ) NOT NULL;

GRANT SELECT, INSERT, UPDATE ON cmhub.air_receipt_evidence_assets TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.air_pickup_orders TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.shipments TO 'cmhub_api'@'127.0.0.1';
FLUSH PRIVILEGES;
