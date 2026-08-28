-- CM-HUB: first-party warehouse identity, least-privilege shipment delivery,
-- browser workstation identity, and auditable QZ submission outcomes.
-- Apply once after 004_add_label_assets_and_shipment_events.sql on MySQL 8.0.

USE cmhub;

-- Machine identifiers are case-sensitive even though human-facing codes/emails are not.
ALTER TABLE integration_api_keys
  MODIFY COLUMN key_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;

CREATE TABLE warehouses (
  id CHAR(36) NOT NULL,
  warehouse_code VARCHAR(64) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  warehouse_status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouses_code (warehouse_code)
) ENGINE=InnoDB;

CREATE TABLE warehouse_users (
  id CHAR(36) NOT NULL,
  email VARCHAR(254) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  password_hash VARCHAR(512) NOT NULL,
  user_status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  last_login_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_users_email (email)
) ENGINE=InnoDB;

CREATE TABLE warehouse_memberships (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  role ENUM('OPERATOR', 'SUPERVISOR', 'ADMIN') NOT NULL DEFAULT 'OPERATOR',
  membership_status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_memberships_user_warehouse (user_id, warehouse_id),
  KEY idx_warehouse_memberships_warehouse_role (warehouse_id, role, membership_status),
  CONSTRAINT fk_warehouse_memberships_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_warehouse_memberships_user FOREIGN KEY (user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE warehouse_client_access (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  client_id CHAR(36) NOT NULL,
  access_status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_client_access (warehouse_id, client_id),
  KEY idx_warehouse_client_access_client (client_id, access_status),
  CONSTRAINT fk_warehouse_client_access_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_warehouse_client_access_client FOREIGN KEY (client_id) REFERENCES clients(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE warehouse_sessions (
  id CHAR(36) NOT NULL,
  session_key_id CHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_hash BINARY(32) NOT NULL,
  user_id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  membership_id CHAR(36) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at DATETIME(3) NULL,
  created_ip VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_sessions_key_id (session_key_id),
  KEY idx_warehouse_sessions_user_active (user_id, revoked_at, expires_at),
  KEY idx_warehouse_sessions_warehouse_active (warehouse_id, revoked_at, expires_at),
  CONSTRAINT fk_warehouse_sessions_user FOREIGN KEY (user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_warehouse_sessions_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_warehouse_sessions_membership FOREIGN KEY (membership_id) REFERENCES warehouse_memberships(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE workstations (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  installation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  workstation_status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_workstations_warehouse_installation (warehouse_id, installation_id),
  KEY idx_workstations_warehouse_status (warehouse_id, workstation_status),
  CONSTRAINT fk_workstations_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE shipment_delivery_changes (
  revision BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id CHAR(36) NOT NULL,
  shipment_id CHAR(36) NOT NULL,
  change_type ENUM('SHIPMENT_UPSERTED', 'LABEL_READY', 'LABEL_UNAVAILABLE') NOT NULL,
  changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (revision),
  KEY idx_shipment_delivery_changes_client_revision (client_id, revision),
  KEY idx_shipment_delivery_changes_shipment_revision (shipment_id, revision DESC),
  CONSTRAINT fk_shipment_delivery_changes_client FOREIGN KEY (client_id) REFERENCES clients(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_shipment_delivery_changes_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

INSERT INTO shipment_delivery_changes (client_id, shipment_id, change_type, changed_at)
SELECT client_id, id,
       CASE WHEN current_label_asset_id IS NULL THEN 'SHIPMENT_UPSERTED' ELSE 'LABEL_READY' END,
       updated_at
FROM shipments
ORDER BY updated_at, id;

CREATE TABLE print_attempts (
  id CHAR(36) NOT NULL,
  client_id CHAR(36) NOT NULL,
  shipment_id CHAR(36) NOT NULL,
  label_asset_id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  workstation_id CHAR(36) NOT NULL,
  client_attempt_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  outcome ENUM('SUBMITTED', 'FAILED', 'RESULT_UNKNOWN', 'BLOCKED') NOT NULL,
  printer_name VARCHAR(255) NULL,
  message VARCHAR(1024) NULL,
  occurred_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_print_attempts_workstation_client_attempt (workstation_id, client_attempt_id),
  KEY idx_print_attempts_shipment_occurred (shipment_id, occurred_at DESC),
  KEY idx_print_attempts_warehouse_occurred (warehouse_id, occurred_at DESC),
  CONSTRAINT fk_print_attempts_client FOREIGN KEY (client_id) REFERENCES clients(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_print_attempts_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_print_attempts_label_asset FOREIGN KEY (label_asset_id) REFERENCES label_assets(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_print_attempts_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_print_attempts_user FOREIGN KEY (user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_print_attempts_workstation FOREIGN KEY (workstation_id) REFERENCES workstations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (payload_sha256 REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB;

GRANT SELECT, INSERT, UPDATE ON cmhub.warehouses TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.warehouse_users TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.warehouse_memberships TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.warehouse_client_access TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.warehouse_sessions TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.workstations TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT ON cmhub.shipment_delivery_changes TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT ON cmhub.print_attempts TO 'cmhub_api'@'127.0.0.1';
FLUSH PRIVILEGES;
