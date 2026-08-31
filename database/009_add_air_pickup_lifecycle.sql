-- CM-HUB: globally shared air-pickup order lifecycle, atomic receiving and
-- handover batches, private evidence metadata, and immutable business events.
-- Apply once after 008_add_shared_work_batches_and_intercepts.sql on MySQL 8.0.

USE cmhub;

INSERT INTO warehouse_permissions (permission_code, module_code, display_name, risk_level) VALUES
  ('air_pickups.view', 'air_pickups', '查看空运提货单', 'LOW'),
  ('air_pickups.create', 'air_pickups', '录入空运提货单', 'MEDIUM'),
  ('air_pickups.edit', 'air_pickups', '编辑已录入提货单', 'MEDIUM'),
  ('air_pickups.receive', 'air_pickups', '确认提货单入库', 'MEDIUM'),
  ('air_pickups.handover', 'air_pickups', '创建并确认交仓批次', 'HIGH'),
  ('air_pickups.evidence.add', 'air_pickups', '补充交仓凭证', 'MEDIUM'),
  ('air_pickups.evidence.manage', 'air_pickups', '移除或替换交仓凭证', 'HIGH'),
  ('air_pickups.correct', 'air_pickups', '更正或作废提货单', 'HIGH');

INSERT INTO warehouse_role_permissions (role_id, permission_code)
SELECT '00000000-0000-4000-8000-000000000101', permission_code
FROM warehouse_permissions
WHERE permission_code IN (
  'air_pickups.view', 'air_pickups.create', 'air_pickups.edit',
  'air_pickups.receive', 'air_pickups.handover', 'air_pickups.evidence.add'
);

INSERT INTO warehouse_role_permissions (role_id, permission_code)
SELECT '00000000-0000-4000-8000-000000000102', permission_code
FROM warehouse_permissions
WHERE module_code = 'air_pickups';

CREATE TABLE air_receipt_batches (
  id CHAR(36) NOT NULL,
  batch_no VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  received_at DATETIME(3) NOT NULL,
  created_by_user_id CHAR(36) NULL,
  created_by_reference VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_air_receipt_batches_no (batch_no),
  KEY idx_air_receipt_batches_received (received_at DESC),
  CONSTRAINT fk_air_receipt_batches_creator FOREIGN KEY (created_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE air_handover_batches (
  id CHAR(36) NOT NULL,
  batch_no VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_status ENUM('DRAFT', 'CONFIRMED') NOT NULL DEFAULT 'DRAFT',
  vehicle_no VARCHAR(64) NULL,
  driver_name VARCHAR(100) NULL,
  driver_phone VARCHAR(32) NULL,
  handed_over_at DATETIME(3) NULL,
  created_by_user_id CHAR(36) NULL,
  created_by_reference VARCHAR(64) NOT NULL,
  confirmed_by_user_id CHAR(36) NULL,
  confirmed_by_reference VARCHAR(64) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  confirmed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_air_handover_batches_no (batch_no),
  KEY idx_air_handover_batches_status (batch_status, updated_at DESC),
  CONSTRAINT fk_air_handover_batches_creator FOREIGN KEY (created_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_air_handover_batches_confirmer FOREIGN KEY (confirmed_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (version > 0)
) ENGINE=InnoDB;

CREATE TABLE air_pickup_orders (
  id CHAR(36) NOT NULL,
  bill_no_raw VARCHAR(32) NOT NULL,
  bill_no_display VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bill_no_normalized VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bill_no_is_standard BOOLEAN NOT NULL DEFAULT FALSE,
  cargo_name VARCHAR(100) NULL,
  forecast_cartons INT UNSIGNED NOT NULL,
  forecast_packages INT UNSIGNED NOT NULL,
  forecast_weight DECIMAL(14,3) UNSIGNED NOT NULL,
  forecast_weight_unit ENUM('KG', 'LB') NOT NULL,
  remarks VARCHAR(200) NULL,
  order_status ENUM('RECORDED', 'RECEIVED', 'HANDED_OVER', 'VOIDED') NOT NULL DEFAULT 'RECORDED',
  evidence_status ENUM('NONE', 'PARTIAL', 'COMPLETE') NOT NULL DEFAULT 'NONE',
  actual_cartons INT UNSIGNED NULL,
  actual_packages INT UNSIGNED NULL,
  actual_weight DECIMAL(14,3) UNSIGNED NULL,
  actual_weight_unit ENUM('KG', 'LB') NULL,
  difference_reason VARCHAR(500) NULL,
  receipt_batch_id CHAR(36) NULL,
  handover_batch_id CHAR(36) NULL,
  received_at DATETIME(3) NULL,
  handed_over_at DATETIME(3) NULL,
  created_by_user_id CHAR(36) NULL,
  created_by_reference VARCHAR(64) NOT NULL,
  updated_by_user_id CHAR(36) NULL,
  updated_by_reference VARCHAR(64) NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  void_reason VARCHAR(500) NULL,
  voided_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_air_pickup_orders_normalized (bill_no_normalized),
  KEY idx_air_pickup_orders_status (order_status, updated_at DESC),
  KEY idx_air_pickup_orders_evidence (evidence_status, updated_at DESC),
  KEY idx_air_pickup_orders_receipt_batch (receipt_batch_id),
  KEY idx_air_pickup_orders_handover_batch (handover_batch_id),
  CONSTRAINT fk_air_pickup_orders_receipt_batch FOREIGN KEY (receipt_batch_id) REFERENCES air_receipt_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_air_pickup_orders_handover_batch FOREIGN KEY (handover_batch_id) REFERENCES air_handover_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_air_pickup_orders_creator FOREIGN KEY (created_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_air_pickup_orders_updater FOREIGN KEY (updated_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (forecast_cartons BETWEEN 1 AND 999999),
  CHECK (forecast_packages BETWEEN 1 AND 999999),
  CHECK (forecast_weight > 0),
  CHECK (actual_cartons IS NULL OR actual_cartons BETWEEN 1 AND 999999),
  CHECK (actual_packages IS NULL OR actual_packages BETWEEN 1 AND 999999),
  CHECK (actual_weight IS NULL OR actual_weight > 0),
  CHECK (version > 0)
) ENGINE=InnoDB;

CREATE TABLE air_handover_evidence_assets (
  id CHAR(36) NOT NULL,
  handover_batch_id CHAR(36) NOT NULL,
  evidence_type ENUM('POD', 'LOADING') NOT NULL,
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
  removed_by_user_id CHAR(36) NULL,
  removed_by_reference VARCHAR(64) NULL,
  removal_reason VARCHAR(500) NULL,
  removed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_air_handover_evidence_content (handover_batch_id, evidence_type, content_sha256),
  KEY idx_air_handover_evidence_active (handover_batch_id, asset_status, evidence_type, created_at),
  CONSTRAINT fk_air_handover_evidence_batch FOREIGN KEY (handover_batch_id) REFERENCES air_handover_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_air_handover_evidence_uploader FOREIGN KEY (uploaded_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_air_handover_evidence_remover FOREIGN KEY (removed_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (content_sha256 REGEXP '^[0-9a-f]{64}$'),
  CHECK (byte_size BETWEEN 1 AND 10485760),
  CHECK (pixel_width >= 800 AND pixel_height >= 600)
) ENGINE=InnoDB;

CREATE TABLE air_pickup_events (
  revision BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id CHAR(36) NULL,
  receipt_batch_id CHAR(36) NULL,
  handover_batch_id CHAR(36) NULL,
  event_type ENUM(
    'ORDER_RECORDED', 'ORDER_EDITED', 'ORDER_RECEIVED', 'ORDER_HANDED_OVER',
    'ORDER_VOIDED', 'HANDOVER_DRAFT_CREATED', 'EVIDENCE_ADDED', 'EVIDENCE_REMOVED',
    'ORDER_CORRECTED'
  ) NOT NULL,
  actor_user_id CHAR(36) NULL,
  actor_reference VARCHAR(64) NOT NULL,
  request_id VARCHAR(64) NOT NULL,
  ip_address VARCHAR(64) NULL,
  reason VARCHAR(500) NULL,
  event_data JSON NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (revision),
  KEY idx_air_pickup_events_order (order_id, revision DESC),
  KEY idx_air_pickup_events_handover (handover_batch_id, revision DESC),
  CONSTRAINT fk_air_pickup_events_order FOREIGN KEY (order_id) REFERENCES air_pickup_orders(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_air_pickup_events_receipt FOREIGN KEY (receipt_batch_id) REFERENCES air_receipt_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_air_pickup_events_handover FOREIGN KEY (handover_batch_id) REFERENCES air_handover_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_air_pickup_events_actor FOREIGN KEY (actor_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL
) ENGINE=InnoDB;

GRANT SELECT, INSERT, UPDATE ON cmhub.air_receipt_batches TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.air_handover_batches TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.air_pickup_orders TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.air_handover_evidence_assets TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT ON cmhub.air_pickup_events TO 'cmhub_api'@'127.0.0.1';
FLUSH PRIVILEGES;
