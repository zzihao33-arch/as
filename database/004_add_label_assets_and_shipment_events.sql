-- CM-HUB: private US-hosted label assets and general shipment event history.
-- Apply once after 003_harden_upstream_integrations.sql on MySQL 8.0.

USE cmhub;

CREATE TABLE label_assets (
  id CHAR(36) NOT NULL,
  client_id CHAR(36) NOT NULL,
  shipment_id CHAR(36) NOT NULL,
  uploaded_by_api_key_id CHAR(36) NOT NULL,
  source_type ENUM('UPSTREAM_PUSH') NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  content_sha256 CHAR(64) NOT NULL,
  content_type VARCHAR(128) NOT NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  asset_status ENUM('STORING', 'READY', 'FAILED') NOT NULL DEFAULT 'STORING',
  failure_code VARCHAR(64) NULL,
  ready_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_label_assets_shipment_sha (shipment_id, content_sha256),
  UNIQUE KEY uq_label_assets_storage_key (storage_key),
  KEY idx_label_assets_client_status_created (client_id, asset_status, created_at DESC),
  CONSTRAINT fk_label_assets_client
    FOREIGN KEY (client_id) REFERENCES clients(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_label_assets_shipment
    FOREIGN KEY (shipment_id) REFERENCES shipments(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_label_assets_api_key
    FOREIGN KEY (uploaded_by_api_key_id) REFERENCES integration_api_keys(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (content_sha256 REGEXP '^[0-9a-f]{64}$'),
  CHECK (byte_size > 0),
  CHECK (content_type = 'application/pdf')
) ENGINE=InnoDB;

ALTER TABLE shipments
  ADD COLUMN current_label_asset_id CHAR(36) NULL AFTER label_sha256,
  ADD KEY idx_shipments_current_label_asset (current_label_asset_id),
  ADD CONSTRAINT fk_shipments_current_label_asset
    FOREIGN KEY (current_label_asset_id) REFERENCES label_assets(id)
    ON UPDATE RESTRICT ON DELETE SET NULL;

CREATE TABLE shipment_events (
  id CHAR(36) NOT NULL,
  client_id CHAR(36) NOT NULL,
  shipment_id CHAR(36) NOT NULL,
  request_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  actor_type ENUM('UPSTREAM_API_KEY', 'SYSTEM', 'WAREHOUSE_USER', 'WORKSTATION') NOT NULL,
  actor_id CHAR(36) NULL,
  event_data JSON NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_shipment_events_client_occurred (client_id, occurred_at DESC),
  KEY idx_shipment_events_shipment_occurred (shipment_id, occurred_at DESC),
  KEY idx_shipment_events_request_id (request_id),
  CONSTRAINT fk_shipment_events_client
    FOREIGN KEY (client_id) REFERENCES clients(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_shipment_events_shipment
    FOREIGN KEY (shipment_id) REFERENCES shipments(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

-- Preserve the earlier general shipment audit records, which were temporarily stored in print_logs.
INSERT INTO shipment_events
  (id, client_id, shipment_id, request_id, event_type, actor_type, actor_id, event_data, occurred_at, created_at)
SELECT
  id, client_id, shipment_id, request_id, event_type, 'SYSTEM', NULL,
  JSON_OBJECT('migratedFrom', 'print_logs', 'legacyMetadata', metadata),
  occurred_at, created_at
FROM print_logs
WHERE event_type = 'SHIPMENT_UPSERTED' AND shipment_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON cmhub.label_assets TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT ON cmhub.shipment_events TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, UPDATE ON cmhub.shipments TO 'cmhub_api'@'127.0.0.1';
FLUSH PRIVILEGES;
