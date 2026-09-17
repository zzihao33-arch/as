-- Additive, MySQL 8.0.45. Apply schema statements as migration owner after 017.
-- Tables inherit the selected schema charset/collation (including 0900_ai_ci).
-- No foreign keys: preserve failed/unattributed attempts and account read state
-- independently of business transactions and identity/client lifecycle.
USE cmhub;

CREATE TABLE integration_push_log_sequence (
  singleton TINYINT UNSIGNED NOT NULL,
  last_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (singleton),
  CHECK (singleton = 1)
) ENGINE=InnoDB;
INSERT INTO integration_push_log_sequence (singleton, last_id) VALUES (1, 0);

-- IDs are allocated under the singleton row lock, held until the log INSERT
-- commits. Do not replace this with AUTO_INCREMENT: allocation order is not
-- commit order, and MAX(id) would then permit unread attempts to be skipped.
CREATE TABLE integration_push_logs (
  id BIGINT UNSIGNED NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NOT NULL,
  request_id VARCHAR(64) NOT NULL,
  client_id CHAR(36) NULL,
  operation VARCHAR(32) NOT NULL,
  method VARCHAR(8) NOT NULL,
  endpoint VARCHAR(160) NOT NULL,
  reference VARCHAR(128) NULL,
  related_reference VARCHAR(128) NULL,
  http_status SMALLINT UNSIGNED NOT NULL,
  duration_ms INT UNSIGNED NOT NULL,
  error_code VARCHAR(64) NULL,
  request_summary JSON NOT NULL,
  response_summary JSON NOT NULL,
  PRIMARY KEY (id),
  KEY idx_integration_push_client (client_id, id),
  KEY idx_integration_push_time (occurred_at, id),
  KEY idx_integration_push_request (request_id),
  KEY idx_integration_push_reference (reference),
  KEY idx_integration_push_related_reference (related_reference),
  CHECK (http_status BETWEEN 100 AND 599),
  CHECK (JSON_STORAGE_SIZE(request_summary) <= 2048),
  CHECK (JSON_STORAGE_SIZE(response_summary) <= 2048)
) ENGINE=InnoDB;

CREATE TABLE integration_push_log_reads (
  user_id CHAR(36) NOT NULL,
  observed_cursor BIGINT UNSIGNED NOT NULL DEFAULT 0,
  read_cursor BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id),
  CHECK (read_cursor <= observed_cursor)
) ENGINE=InnoDB;

INSERT INTO warehouse_permissions (permission_code, module_code, display_name, risk_level)
VALUES ('integration_logs.view', 'integration_logs', '查看客户推送日志', 'HIGH');

-- Capability-based initial grant, including custom highest-privilege roles.
-- Subsequently configurable through the existing role permission editor.
INSERT INTO warehouse_role_permissions (role_id, permission_code)
SELECT a.role_id, 'integration_logs.view'
FROM warehouse_role_permissions a
INNER JOIN warehouse_role_permissions r ON r.role_id = a.role_id AND r.permission_code = 'roles.manage'
WHERE a.permission_code = 'accounts.manage';

-- applyMigrations.mjs intentionally skips GRANT; DBA must execute these exact
-- three statements separately for the existing production application account.
GRANT SELECT, INSERT ON cmhub.integration_push_logs TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, UPDATE ON cmhub.integration_push_log_sequence TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.integration_push_log_reads TO 'cmhub_api'@'127.0.0.1';
