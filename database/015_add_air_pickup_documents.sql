CREATE TABLE air_pickup_document_assets (
  id CHAR(36) NOT NULL,
  order_id CHAR(36) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  content_sha256 CHAR(64) NOT NULL,
  content_type ENUM(
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv'
  ) NOT NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  asset_status ENUM('READY', 'REMOVED') NOT NULL DEFAULT 'READY',
  uploaded_by_user_id CHAR(36) NULL,
  uploaded_by_reference VARCHAR(128) NOT NULL,
  removed_by_user_id CHAR(36) NULL,
  removed_by_reference VARCHAR(128) NULL,
  removed_reason VARCHAR(500) NULL,
  removed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_air_pickup_document_order_hash (order_id, content_sha256),
  KEY idx_air_pickup_document_order_status_created (order_id, asset_status, created_at),
  CONSTRAINT fk_air_pickup_document_order FOREIGN KEY (order_id) REFERENCES air_pickup_orders(id),
  CONSTRAINT chk_air_pickup_document_byte_size CHECK (byte_size > 0 AND byte_size <= 20971520)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE air_pickup_events
  MODIFY COLUMN event_type ENUM(
    'ORDER_RECORDED', 'ORDER_EDITED', 'ORDER_RECEIVED', 'ORDER_HANDED_OVER', 'ORDER_VOIDED',
    'HANDOVER_DRAFT_CREATED', 'EVIDENCE_ADDED', 'EVIDENCE_REMOVED', 'ORDER_CORRECTED',
    'RECEIPT_EVIDENCE_ADDED', 'PICKUP_DOCUMENT_ADDED', 'PICKUP_DOCUMENT_REMOVED'
  ) NOT NULL;
