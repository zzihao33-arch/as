-- T2 durable operation ledger. Apply once after 012 on MySQL 8.0.16+.
-- Additive only. T3 must wire every v2 business writer before advertising operations=2.
USE cmhub;

CREATE TABLE warehouse_ui_operations (
  operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_reference VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_user_id CHAR(36) NULL,
  actor_context JSON NOT NULL,
  scope_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_type ENUM('AIR_PICKUP_CREATE', 'AIR_RECEIPT_CREATE', 'AIR_HANDOVER_CREATE') NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  canonicalization_version SMALLINT UNSIGNED NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('PROCESSING', 'COMPLETED', 'FAILED_NOT_SAVED') NOT NULL,
  attempt_no INT UNSIGNED NOT NULL DEFAULT 1,
  record_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  record_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  record_no VARCHAR(128) NULL,
  result_summary JSON NULL,
  error_code VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_details JSON NULL,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (operation_id),
  KEY idx_ui_operations_processing (status, updated_at),
  KEY idx_ui_operations_actor (actor_reference, scope_key, created_at),
  CONSTRAINT fk_ui_operations_actor FOREIGN KEY (actor_user_id) REFERENCES warehouse_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_ui_operations_attempt CHECK (attempt_no BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_ui_operations_scope CHECK (scope_key <> ''),
  CONSTRAINT chk_ui_operations_result CHECK (
    (status = 'COMPLETED' AND record_type IS NOT NULL AND record_id IS NOT NULL AND completed_at IS NOT NULL AND retryable = FALSE)
    OR (status <> 'COMPLETED' AND record_type IS NULL AND record_id IS NULL AND record_no IS NULL)
  ),
  CONSTRAINT chk_ui_operations_retry CHECK (retryable = FALSE OR status = 'FAILED_NOT_SAVED')
) ENGINE=InnoDB;
