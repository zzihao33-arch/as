-- CM-HUB: durable, signed upstream callbacks with leased delivery, retry audit,
-- dead-letter handling, and manual replay cycles.
-- Apply once after 005_add_warehouse_identity_and_print_attempts.sql on MySQL 8.0.

USE cmhub;

CREATE TABLE client_callback_endpoints (
  id CHAR(36) NOT NULL,
  client_id CHAR(36) NOT NULL,
  callback_url VARCHAR(2048) NOT NULL,
  secret_ciphertext VARBINARY(512) NOT NULL,
  secret_iv BINARY(12) NOT NULL,
  secret_auth_tag BINARY(16) NOT NULL,
  encryption_key_version VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  signing_version ENUM('HMAC_SHA256_V1') NOT NULL DEFAULT 'HMAC_SHA256_V1',
  endpoint_status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_client_callback_endpoints_client (client_id),
  KEY idx_client_callback_endpoints_status (endpoint_status),
  CONSTRAINT fk_client_callback_endpoints_client FOREIGN KEY (client_id) REFERENCES clients(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE outbound_webhook_events (
  id CHAR(36) NOT NULL,
  client_id CHAR(36) NOT NULL,
  shipment_id CHAR(36) NOT NULL,
  source_print_attempt_id CHAR(36) NOT NULL,
  endpoint_id CHAR(36) NULL,
  event_type ENUM(
    'SHIPMENT_PRINT_SUBMITTED',
    'SHIPMENT_PRINT_FAILED',
    'SHIPMENT_PRINT_RESULT_UNKNOWN',
    'SHIPMENT_PRINT_BLOCKED'
  ) NOT NULL,
  payload_body LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  payload_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  delivery_status ENUM(
    'WAITING_CONFIGURATION',
    'PENDING',
    'DELIVERING',
    'RETRY_SCHEDULED',
    'DELIVERED',
    'DEAD_LETTER'
  ) NOT NULL,
  replay_count INT UNSIGNED NOT NULL DEFAULT 0,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NULL,
  lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at DATETIME(3) NULL,
  last_attempt_at DATETIME(3) NULL,
  last_http_status SMALLINT UNSIGNED NULL,
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  last_error_message VARCHAR(1024) NULL,
  delivered_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_outbound_webhook_events_print_attempt (source_print_attempt_id),
  KEY idx_outbound_webhook_events_due (delivery_status, next_attempt_at, lease_expires_at),
  KEY idx_outbound_webhook_events_client_created (client_id, created_at DESC),
  KEY idx_outbound_webhook_events_shipment_created (shipment_id, created_at DESC),
  CONSTRAINT fk_outbound_webhook_events_client FOREIGN KEY (client_id) REFERENCES clients(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_outbound_webhook_events_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_outbound_webhook_events_print_attempt FOREIGN KEY (source_print_attempt_id) REFERENCES print_attempts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_outbound_webhook_events_endpoint FOREIGN KEY (endpoint_id) REFERENCES client_callback_endpoints(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (payload_sha256 REGEXP '^[0-9a-f]{64}$'),
  CHECK (last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599)
) ENGINE=InnoDB;

CREATE TABLE outbound_webhook_attempts (
  id CHAR(36) NOT NULL,
  event_id CHAR(36) NOT NULL,
  replay_number INT UNSIGNED NOT NULL,
  attempt_number INT UNSIGNED NOT NULL,
  lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_timestamp BIGINT UNSIGNED NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  http_status SMALLINT UNSIGNED NULL,
  outcome ENUM('IN_PROGRESS', 'DELIVERED', 'RETRY', 'DEAD_LETTER') NOT NULL,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  response_excerpt VARCHAR(1024) NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_outbound_webhook_attempts_lease (lease_token),
  UNIQUE KEY uq_outbound_webhook_attempts_cycle (event_id, replay_number, attempt_number),
  KEY idx_outbound_webhook_attempts_event_started (event_id, started_at DESC),
  CONSTRAINT fk_outbound_webhook_attempts_event FOREIGN KEY (event_id) REFERENCES outbound_webhook_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (request_sha256 REGEXP '^[0-9a-f]{64}$'),
  CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599)
) ENGINE=InnoDB;

GRANT SELECT, INSERT, UPDATE ON cmhub.client_callback_endpoints TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.outbound_webhook_events TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.outbound_webhook_attempts TO 'cmhub_api'@'127.0.0.1';
FLUSH PRIVILEGES;
