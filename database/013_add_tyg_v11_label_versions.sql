-- TYG v1.1 is intentionally additive.  Legacy shipment and raw-PDF routes
-- continue to use shipments/label_assets without these version records.

ALTER TABLE label_assets
  ADD COLUMN retention_expires_at DATETIME(3) NULL AFTER ready_at,
  ADD KEY idx_label_assets_retention (asset_status, retention_expires_at);

CREATE TABLE tyg_label_versions (
  id CHAR(36) NOT NULL,
  shipment_id CHAR(36) NOT NULL,
  label_asset_id CHAR(36) NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  original_tracking_no VARCHAR(128) NOT NULL,
  transfer_tracking_no VARCHAR(128) NOT NULL,
  replacement_reason VARCHAR(200) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tyg_label_versions_shipment_version (shipment_id, version_no),
  KEY idx_tyg_label_versions_shipment_created (shipment_id, created_at DESC),
  CONSTRAINT fk_tyg_label_versions_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tyg_label_versions_asset FOREIGN KEY (label_asset_id) REFERENCES label_assets(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (version_no > 0)
) ENGINE=InnoDB;

GRANT SELECT, INSERT, UPDATE ON cmhub.tyg_label_versions TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, UPDATE ON cmhub.label_assets TO 'cmhub_api'@'127.0.0.1';
FLUSH PRIVILEGES;
