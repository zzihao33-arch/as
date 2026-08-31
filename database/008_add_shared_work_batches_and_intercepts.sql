-- CM-HUB: cross-workstation import batches, atomic scan claims, and the global
-- intercept registry. Apply once after 007_add_global_identity_and_rbac.sql.

USE cmhub;

CREATE TABLE warehouse_work_batches (
  id CHAR(36) NOT NULL,
  batch_name VARCHAR(128) NOT NULL,
  batch_status ENUM('DRAFT', 'ACTIVE', 'CLOSED') NOT NULL DEFAULT 'DRAFT',
  created_by_user_id CHAR(36) NULL,
  created_by_reference VARCHAR(64) NOT NULL,
  mapping_count INT UNSIGNED NOT NULL DEFAULT 0,
  pdf_count INT UNSIGNED NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  published_at DATETIME(3) NULL,
  closed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_warehouse_work_batches_status (batch_status, updated_at DESC),
  CONSTRAINT fk_warehouse_work_batches_creator FOREIGN KEY (created_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (version > 0)
) ENGINE=InnoDB;

CREATE TABLE warehouse_work_batch_assets (
  id CHAR(36) NOT NULL,
  batch_id CHAR(36) NOT NULL,
  lookup_key VARCHAR(128) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  storage_key VARCHAR(768) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_type VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'application/pdf',
  byte_size BIGINT UNSIGNED NOT NULL,
  asset_status ENUM('STORING', 'READY', 'FAILED') NOT NULL DEFAULT 'STORING',
  failure_code VARCHAR(64) NULL,
  uploaded_by_user_id CHAR(36) NULL,
  uploaded_by_reference VARCHAR(64) NOT NULL,
  ready_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_work_batch_assets_lookup (batch_id, lookup_key),
  KEY idx_warehouse_work_batch_assets_status (batch_id, asset_status, created_at),
  CONSTRAINT fk_warehouse_work_batch_assets_batch FOREIGN KEY (batch_id) REFERENCES warehouse_work_batches(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_warehouse_work_batch_assets_uploader FOREIGN KEY (uploaded_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (content_sha256 REGEXP '^[0-9a-f]{64}$'),
  CHECK (byte_size > 0)
) ENGINE=InnoDB;

CREATE TABLE warehouse_work_batch_items (
  id CHAR(36) NOT NULL,
  batch_id CHAR(36) NOT NULL,
  first_leg_tracking_no VARCHAR(128) NOT NULL,
  courier_tracking_no VARCHAR(128) NULL,
  label_asset_id CHAR(36) NULL,
  item_status ENUM('PENDING', 'CLAIMED', 'SUBMITTED', 'FAILED', 'RESULT_UNKNOWN', 'BLOCKED') NOT NULL DEFAULT 'PENDING',
  item_version INT UNSIGNED NOT NULL DEFAULT 1,
  claimed_by_user_id CHAR(36) NULL,
  claimed_by_workstation_id CHAR(36) NULL,
  claim_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  claim_expires_at DATETIME(3) NULL,
  last_outcome_message VARCHAR(1024) NULL,
  raw_data JSON NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_work_batch_items_first_leg (batch_id, first_leg_tracking_no),
  KEY idx_warehouse_work_batch_items_courier (batch_id, courier_tracking_no),
  KEY idx_warehouse_work_batch_items_status (batch_id, item_status, updated_at),
  KEY idx_warehouse_work_batch_items_claim (claim_expires_at, item_status),
  CONSTRAINT fk_warehouse_work_batch_items_batch FOREIGN KEY (batch_id) REFERENCES warehouse_work_batches(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_warehouse_work_batch_items_asset FOREIGN KEY (label_asset_id) REFERENCES warehouse_work_batch_assets(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_warehouse_work_batch_items_user FOREIGN KEY (claimed_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_warehouse_work_batch_items_workstation FOREIGN KEY (claimed_by_workstation_id) REFERENCES workstations(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (item_version > 0)
) ENGINE=InnoDB;

CREATE TABLE warehouse_work_batch_changes (
  revision BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id CHAR(36) NOT NULL,
  item_id CHAR(36) NULL,
  change_type ENUM('BATCH_CREATED', 'ITEMS_UPSERTED', 'ASSET_READY', 'BATCH_PUBLISHED', 'ITEM_CLAIMED', 'ITEM_COMPLETED', 'BATCH_CLOSED') NOT NULL,
  changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (revision),
  KEY idx_warehouse_work_batch_changes_batch (batch_id, revision),
  CONSTRAINT fk_warehouse_work_batch_changes_batch FOREIGN KEY (batch_id) REFERENCES warehouse_work_batches(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_warehouse_work_batch_changes_item FOREIGN KEY (item_id) REFERENCES warehouse_work_batch_items(id) ON UPDATE RESTRICT ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE warehouse_work_batch_print_attempts (
  id CHAR(36) NOT NULL,
  batch_id CHAR(36) NOT NULL,
  item_id CHAR(36) NOT NULL,
  label_asset_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  actor_reference VARCHAR(64) NOT NULL,
  workstation_id CHAR(36) NOT NULL,
  client_attempt_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claim_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  outcome ENUM('SUBMITTED', 'FAILED', 'RESULT_UNKNOWN', 'BLOCKED') NOT NULL,
  printer_name VARCHAR(255) NULL,
  message VARCHAR(1024) NULL,
  occurred_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_work_batch_attempt_client (workstation_id, client_attempt_id),
  KEY idx_warehouse_work_batch_attempt_item (item_id, occurred_at DESC),
  CONSTRAINT fk_warehouse_work_batch_attempt_batch FOREIGN KEY (batch_id) REFERENCES warehouse_work_batches(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_warehouse_work_batch_attempt_item FOREIGN KEY (item_id) REFERENCES warehouse_work_batch_items(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_warehouse_work_batch_attempt_asset FOREIGN KEY (label_asset_id) REFERENCES warehouse_work_batch_assets(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_warehouse_work_batch_attempt_user FOREIGN KEY (user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_warehouse_work_batch_attempt_workstation FOREIGN KEY (workstation_id) REFERENCES workstations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (payload_sha256 REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB;

CREATE TABLE global_intercepts (
  id CHAR(36) NOT NULL,
  tracking_no VARCHAR(128) NOT NULL,
  intercept_reason VARCHAR(512) NULL,
  source_type ENUM('MANUAL', 'BULK_IMPORT', 'UPSTREAM') NOT NULL DEFAULT 'MANUAL',
  intercept_status ENUM('ACTIVE', 'REMOVED') NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id CHAR(36) NULL,
  created_by_reference VARCHAR(64) NOT NULL,
  updated_by_user_id CHAR(36) NULL,
  updated_by_reference VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_global_intercepts_tracking (tracking_no),
  KEY idx_global_intercepts_status (intercept_status, updated_at DESC),
  CONSTRAINT fk_global_intercepts_creator FOREIGN KEY (created_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_global_intercepts_updater FOREIGN KEY (updated_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE global_intercept_changes (
  revision BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  intercept_id CHAR(36) NOT NULL,
  change_type ENUM('UPSERTED', 'REMOVED') NOT NULL,
  changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (revision),
  KEY idx_global_intercept_changes_revision (revision, changed_at),
  CONSTRAINT fk_global_intercept_changes_intercept FOREIGN KEY (intercept_id) REFERENCES global_intercepts(id) ON UPDATE RESTRICT ON DELETE CASCADE
) ENGINE=InnoDB;

GRANT SELECT, INSERT, UPDATE, DELETE ON cmhub.warehouse_work_batches TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON cmhub.warehouse_work_batch_assets TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON cmhub.warehouse_work_batch_items TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT ON cmhub.warehouse_work_batch_changes TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.warehouse_work_batch_print_attempts TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.global_intercepts TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT ON cmhub.global_intercept_changes TO 'cmhub_api'@'127.0.0.1';
FLUSH PRIVILEGES;
