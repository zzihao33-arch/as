-- CM-HUB cloud integration base schema for MySQL 8.0.
-- Apply once with a MySQL administrative account, then apply every later numbered migration.
-- The MySQL service account created below is not a client API credential.

CREATE DATABASE IF NOT EXISTS cmhub
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE cmhub;

CREATE TABLE IF NOT EXISTS clients (
  id CHAR(36) NOT NULL,
  client_code VARCHAR(64) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  key_id VARCHAR(32) NOT NULL,
  api_key_prefix VARCHAR(32) NOT NULL,
  api_key_hash BINARY(32) NOT NULL,
  key_status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  rate_limit_per_minute INT UNSIGNED NOT NULL DEFAULT 600,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_clients_client_code (client_code),
  UNIQUE KEY uq_clients_key_id (key_id),
  CHECK (rate_limit_per_minute BETWEEN 1 AND 10000)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS shipments (
  id CHAR(36) NOT NULL,
  client_id CHAR(36) NOT NULL,
  first_leg_tracking_no VARCHAR(128) NOT NULL,
  courier_tracking_no VARCHAR(128) NULL,
  carrier VARCHAR(64) NULL,
  label_url VARCHAR(2048) NULL,
  label_sha256 CHAR(64) NULL,
  status ENUM('RECEIVED', 'READY_TO_PRINT', 'PRINTED', 'BLOCKED', 'PRINT_FAILED', 'CANCELLED') NOT NULL DEFAULT 'RECEIVED',
  attributes JSON NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_shipments_client_first_leg (client_id, first_leg_tracking_no),
  KEY idx_shipments_client_courier (client_id, courier_tracking_no),
  KEY idx_shipments_client_status_updated (client_id, status, updated_at DESC),
  CONSTRAINT fk_shipments_client
    FOREIGN KEY (client_id) REFERENCES clients(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (label_sha256 IS NULL OR label_sha256 REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS print_logs (
  id CHAR(36) NOT NULL,
  client_id CHAR(36) NOT NULL,
  shipment_id CHAR(36) NULL,
  request_id VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NULL,
  event_type ENUM('SHIPMENT_UPSERTED', 'PRINT_SUBMITTED', 'PRINT_SUCCEEDED', 'PRINT_FAILED', 'PRINT_BLOCKED') NOT NULL,
  outcome ENUM('SUCCESS', 'FAILED', 'BLOCKED') NOT NULL,
  terminal_id VARCHAR(128) NULL,
  printer_name VARCHAR(255) NULL,
  message VARCHAR(1024) NULL,
  metadata JSON NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_print_logs_client_occurred (client_id, occurred_at DESC),
  KEY idx_print_logs_shipment_occurred (shipment_id, occurred_at DESC),
  KEY idx_print_logs_request_id (request_id),
  CONSTRAINT fk_print_logs_client
    FOREIGN KEY (client_id) REFERENCES clients(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_print_logs_shipment
    FOREIGN KEY (shipment_id) REFERENCES shipments(id)
    ON UPDATE RESTRICT ON DELETE SET NULL
) ENGINE=InnoDB;

-- Run the application as a least-privileged MySQL user. Replace the password before executing.
CREATE USER IF NOT EXISTS 'cmhub_api'@'127.0.0.1' IDENTIFIED BY 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';
GRANT SELECT, INSERT, UPDATE ON cmhub.clients TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.shipments TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT ON cmhub.print_logs TO 'cmhub_api'@'127.0.0.1';
FLUSH PRIVILEGES;
