-- Candidate document feature; no existing role receives permissions in this migration.
USE cmhub;
INSERT INTO warehouse_permissions (permission_code, module_code, display_name, risk_level) VALUES
('air_pickups.documents.view', 'air_pickups', '查看提货原件', 'LOW'),
('air_pickups.documents.download', 'air_pickups', '下载提货原件', 'MEDIUM'),
('air_pickups.documents.add', 'air_pickups', '上传提货原件', 'MEDIUM'),
('air_pickups.documents.manage', 'air_pickups', '维护提货原件及历史', 'HIGH');
ALTER TABLE air_pickup_orders ADD COLUMN documents_revision BIGINT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE air_pickup_events MODIFY COLUMN event_type ENUM('ORDER_RECORDED','ORDER_EDITED','ORDER_RECEIVED','ORDER_HANDED_OVER','ORDER_VOIDED','HANDOVER_DRAFT_CREATED','EVIDENCE_ADDED','EVIDENCE_REMOVED','ORDER_CORRECTED','RECEIPT_EVIDENCE_ADDED','PICKUP_DOCUMENT_ADDED','PICKUP_DOCUMENT_REMOVED','DOCUMENT_ADDED','DOCUMENT_REPLACED','DOCUMENT_REMOVED') NOT NULL,
 MODIFY COLUMN reason VARCHAR(1000) NULL;
ALTER TABLE warehouse_ui_operations
 MODIFY COLUMN operation_type ENUM('AIR_PICKUP_CREATE','AIR_RECEIPT_CREATE','AIR_HANDOVER_CREATE','PICKUP_DOCUMENT_UPLOAD','PICKUP_DOCUMENT_REMOVE','PICKUP_DOCUMENT_PREVIEW_RETRY') NOT NULL,
 ADD COLUMN document_phase VARCHAR(32) NULL,
 ADD COLUMN document_lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
 ADD COLUMN document_lease_expires_at DATETIME(3) NULL;
CREATE TABLE air_pickup_document_uploads (
 upload_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 order_id CHAR(36) NOT NULL,
 actor_reference VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 scope_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'GLOBAL',
 registration_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 metadata JSON NOT NULL,
 reauthenticated_at DATETIME(3) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 CONSTRAINT fk_document_upload_order FOREIGN KEY (order_id) REFERENCES air_pickup_orders(id),
 CONSTRAINT chk_document_upload_scope CHECK (scope_key = 'GLOBAL')
) ENGINE=InnoDB;
-- Keep the existing 015 legacy asset table intact for old rows and read-only downloads.
CREATE TABLE air_pickup_document_assets_v2 (
 id CHAR(36) NOT NULL PRIMARY KEY,
 order_id CHAR(36) NOT NULL,
 original_filename VARCHAR(240) NOT NULL,
 detected_content_type VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 byte_size BIGINT UNSIGNED NOT NULL,
 content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 storage_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 asset_status ENUM('READY','REMOVED','SUPERSEDED') NOT NULL DEFAULT 'READY',
 active_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (CASE WHEN asset_status = 'READY' THEN content_sha256 ELSE NULL END) STORED,
 asset_version INT UNSIGNED NOT NULL DEFAULT 1,
 created_by_reference VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 removed_by_reference VARCHAR(160) NULL, removed_reason VARCHAR(1000) NULL, removed_at DATETIME(3) NULL,
 supersedes_asset_id CHAR(36) NULL,
 creation_upload_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 preview_generation INT UNSIGNED NOT NULL DEFAULT 1,
 UNIQUE KEY uq_document_active_hash (order_id, active_sha256),
 UNIQUE KEY uq_document_creation_upload (creation_upload_id),
 KEY idx_document_order (order_id, created_at, id),
 CONSTRAINT fk_document_asset_order FOREIGN KEY (order_id) REFERENCES air_pickup_orders(id),
 CONSTRAINT fk_document_asset_upload FOREIGN KEY (creation_upload_id) REFERENCES air_pickup_document_uploads(upload_id),
 CONSTRAINT fk_document_supersedes FOREIGN KEY (supersedes_asset_id) REFERENCES air_pickup_document_assets_v2(id)
) ENGINE=InnoDB;
CREATE TABLE air_pickup_document_previews (
 asset_id CHAR(36) NOT NULL, generation INT UNSIGNED NOT NULL,
 source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 converter_version VARCHAR(64) NOT NULL,
 preview_status ENUM('QUEUED','RUNNING','READY','FAILED','UNSUPPORTED') NOT NULL,
 lease_token CHAR(36) NULL, expires_at DATETIME(3) NULL, attempt INT UNSIGNED NOT NULL DEFAULT 0,
 preview_storage_key VARCHAR(255) NULL, page_count INT UNSIGNED NULL, error_code VARCHAR(96) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), finished_at DATETIME(3) NULL,
 PRIMARY KEY (asset_id, generation), KEY idx_document_preview_jobs (preview_status, expires_at),
 CONSTRAINT fk_document_preview_asset FOREIGN KEY (asset_id) REFERENCES air_pickup_document_assets_v2(id)
) ENGINE=InnoDB;
CREATE TABLE air_pickup_document_orphan_candidates (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 upload_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 attempt_no INT UNSIGNED NOT NULL,
 storage_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 reason VARCHAR(96) NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 KEY idx_document_orphan_upload (upload_id, attempt_no)
) ENGINE=InnoDB;
