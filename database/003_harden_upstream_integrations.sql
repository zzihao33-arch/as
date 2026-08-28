-- CM-HUB: separate partner identity from rotatable API credentials and persist every inbound request.
-- Apply once after 002_add_upstream_raw_payload.sql on MySQL 8.0.
--
-- This is a transition migration: the legacy credential columns on clients remain in place so the
-- currently deployed release can be rolled back safely. The application switches to
-- integration_api_keys after this migration. A later migration may remove the legacy columns.

USE cmhub;

ALTER TABLE clients
  ADD COLUMN client_status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE' AFTER display_name;

CREATE TABLE integration_api_keys (
  id CHAR(36) NOT NULL,
  client_id CHAR(36) NOT NULL,
  key_id VARCHAR(32) NOT NULL,
  api_key_prefix VARCHAR(64) NOT NULL,
  api_key_hash BINARY(32) NOT NULL,
  environment ENUM('LIVE', 'TEST') NOT NULL,
  scopes JSON NOT NULL,
  key_status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  rate_limit_per_minute INT UNSIGNED NOT NULL DEFAULT 600,
  expires_at DATETIME(3) NULL,
  last_used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_integration_api_keys_key_id (key_id),
  KEY idx_integration_api_keys_client_status (client_id, key_status),
  CONSTRAINT fk_integration_api_keys_client
    FOREIGN KEY (client_id) REFERENCES clients(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (rate_limit_per_minute BETWEEN 1 AND 10000)
) ENGINE=InnoDB;

-- Preserve every existing credential as the first credential for its client.
INSERT INTO integration_api_keys
  (id, client_id, key_id, api_key_prefix, api_key_hash, environment, scopes,
   key_status, rate_limit_per_minute, created_at, updated_at)
SELECT
  UUID(), id, key_id, api_key_prefix, api_key_hash,
  CASE WHEN api_key_prefix LIKE 'cmh_test_%' THEN 'TEST' ELSE 'LIVE' END,
  JSON_ARRAY('shipments:write', 'shipments:read', 'labels:write'),
  key_status, rate_limit_per_minute, created_at, updated_at
FROM clients;

CREATE TABLE inbound_messages (
  id CHAR(36) NOT NULL,
  client_id CHAR(36) NOT NULL,
  api_key_id CHAR(36) NOT NULL,
  shipment_id CHAR(36) NULL,
  request_id VARCHAR(64) NOT NULL,
  operation VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  raw_data JSON NOT NULL,
  processing_status ENUM('PROCESSING', 'COMPLETED') NOT NULL DEFAULT 'PROCESSING',
  response_status SMALLINT UNSIGNED NULL,
  response_body JSON NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inbound_messages_client_operation_idempotency (client_id, operation, idempotency_key),
  KEY idx_inbound_messages_client_received (client_id, received_at DESC),
  KEY idx_inbound_messages_request_id (request_id),
  KEY idx_inbound_messages_shipment_received (shipment_id, received_at DESC),
  CONSTRAINT fk_inbound_messages_client
    FOREIGN KEY (client_id) REFERENCES clients(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_inbound_messages_api_key
    FOREIGN KEY (api_key_id) REFERENCES integration_api_keys(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_inbound_messages_shipment
    FOREIGN KEY (shipment_id) REFERENCES shipments(id)
    ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (payload_sha256 REGEXP '^[0-9a-f]{64}$'),
  CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599)
) ENGINE=InnoDB;

GRANT SELECT, INSERT, UPDATE ON cmhub.clients TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.integration_api_keys TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.inbound_messages TO 'cmhub_api'@'127.0.0.1';
FLUSH PRIVILEGES;
