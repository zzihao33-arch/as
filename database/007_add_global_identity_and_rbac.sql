-- CM-HUB: global login names, platform administration, permission-based RBAC,
-- renewable warehouse sessions, and deletion-safe security auditing.
-- Apply once after 006_add_outbound_webhook_outbox.sql on MySQL 8.0.

USE cmhub;

CREATE TABLE warehouse_permissions (
  permission_code VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  module_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  risk_level ENUM('LOW', 'MEDIUM', 'HIGH') NOT NULL DEFAULT 'LOW',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (permission_code),
  KEY idx_warehouse_permissions_module (module_code, permission_code)
) ENGINE=InnoDB;

INSERT INTO warehouse_permissions (permission_code, module_code, display_name, risk_level) VALUES
  ('dashboard.view', 'dashboard', '查看工作概览', 'LOW'),
  ('shipments.view', 'shipments', '查看全部上游物流单据', 'MEDIUM'),
  ('scan.use', 'scan', '使用扫码匹配', 'MEDIUM'),
  ('batches.view', 'batches', '查看共享作业批次', 'LOW'),
  ('batches.create', 'batches', '创建共享作业批次', 'HIGH'),
  ('batches.publish', 'batches', '发布共享作业批次', 'HIGH'),
  ('batches.close', 'batches', '关闭共享作业批次', 'HIGH'),
  ('scan.import_local', 'scan', '使用本机应急导入', 'HIGH'),
  ('offline_mode.enable', 'scan', '启用单机应急模式', 'HIGH'),
  ('print.submit', 'print', '提交首次打印', 'MEDIUM'),
  ('print.reprint', 'print', '再次打印已处理单号', 'HIGH'),
  ('print_logs.view', 'print_logs', '查看打印审计', 'MEDIUM'),
  ('print_logs.clear_local', 'print_logs', '清理本机日志', 'MEDIUM'),
  ('intercepts.view', 'intercepts', '查看全局拦截条目', 'MEDIUM'),
  ('intercepts.manage', 'intercepts', '维护全局拦截条目', 'HIGH'),
  ('bol.view', 'bol', '查看 BOL', 'LOW'),
  ('bol.manage', 'bol', '创建和编辑 BOL', 'MEDIUM'),
  ('bol.delete', 'bol', '删除 BOL', 'HIGH'),
  ('bol.output', 'bol', '输出 BOL', 'MEDIUM'),
  ('payroll.view', 'payroll', '查看考勤薪酬', 'HIGH'),
  ('payroll.manage', 'payroll', '维护考勤薪酬', 'HIGH'),
  ('payroll.export', 'payroll', '导出考勤薪酬', 'HIGH'),
  ('settings.printer', 'settings', '修改本机打印机设置', 'MEDIUM'),
  ('settings.audio', 'settings', '修改本机音效设置', 'LOW'),
  ('system_status.view', 'system_status', '查看系统状态', 'MEDIUM'),
  ('callbacks.view', 'callbacks', '查看上游回调审计', 'HIGH'),
  ('callbacks.retry', 'callbacks', '重放上游回调死信', 'HIGH'),
  ('accounts.view', 'accounts', '查看仓库账户', 'HIGH'),
  ('accounts.manage', 'accounts', '管理仓库账户', 'HIGH'),
  ('accounts.reset_password', 'accounts', '重置仓库账户密码', 'HIGH'),
  ('roles.view', 'roles', '查看角色权限', 'HIGH'),
  ('roles.manage', 'roles', '管理角色权限', 'HIGH'),
  ('security_audit.view', 'security_audit', '查看身份安全审计', 'HIGH');

CREATE TABLE warehouse_roles (
  id CHAR(36) NOT NULL,
  role_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role_name VARCHAR(64) NOT NULL,
  role_description VARCHAR(512) NULL,
  role_kind ENUM('DEFAULT', 'CUSTOM') NOT NULL,
  is_default_operator BOOLEAN NOT NULL DEFAULT FALSE,
  role_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by_user_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouse_roles_code (role_code),
  UNIQUE KEY uq_warehouse_roles_name (role_name),
  KEY idx_warehouse_roles_kind (role_kind, created_at),
  CONSTRAINT fk_warehouse_roles_creator FOREIGN KEY (created_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (role_version > 0)
) ENGINE=InnoDB;

INSERT INTO warehouse_roles
  (id, role_code, role_name, role_description, role_kind, is_default_operator)
VALUES
  ('00000000-0000-4000-8000-000000000101', 'OPERATOR', '仓库操作员', '扫码、首次打印和基础工作站设置。', 'DEFAULT', TRUE),
  ('00000000-0000-4000-8000-000000000102', 'SUPERVISOR', '仓库主管', '共享批次、拦截、异常处理和现场运营审计。', 'DEFAULT', FALSE);

CREATE TABLE warehouse_role_permissions (
  role_id CHAR(36) NOT NULL,
  permission_code VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  granted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (role_id, permission_code),
  CONSTRAINT fk_warehouse_role_permissions_role FOREIGN KEY (role_id) REFERENCES warehouse_roles(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_warehouse_role_permissions_permission FOREIGN KEY (permission_code) REFERENCES warehouse_permissions(permission_code) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

INSERT INTO warehouse_role_permissions (role_id, permission_code)
SELECT '00000000-0000-4000-8000-000000000101', permission_code
FROM warehouse_permissions
WHERE permission_code IN (
  'dashboard.view', 'shipments.view', 'scan.use', 'batches.view',
  'print.submit', 'print_logs.view', 'intercepts.view',
  'settings.printer', 'settings.audio'
);

INSERT INTO warehouse_role_permissions (role_id, permission_code)
SELECT '00000000-0000-4000-8000-000000000102', permission_code
FROM warehouse_permissions
WHERE permission_code IN (
  'dashboard.view', 'shipments.view', 'scan.use', 'batches.view',
  'batches.create', 'batches.publish', 'batches.close',
  'scan.import_local', 'offline_mode.enable',
  'print.submit', 'print.reprint', 'print_logs.view', 'print_logs.clear_local',
  'intercepts.view', 'intercepts.manage',
  'bol.view', 'bol.manage', 'bol.delete', 'bol.output',
  'settings.printer', 'settings.audio', 'system_status.view'
);

ALTER TABLE warehouse_users
  ADD COLUMN login_name VARCHAR(50) NULL AFTER id,
  ADD COLUMN phone VARCHAR(32) NULL AFTER email,
  ADD COLUMN platform_role ENUM('SYSTEM_ADMIN') NULL AFTER user_status,
  ADD COLUMN password_state ENUM('ACTIVE', 'CHANGE_REQUIRED') NOT NULL DEFAULT 'ACTIVE' AFTER password_hash,
  ADD COLUMN password_changed_at DATETIME(3) NULL AFTER last_login_at;

-- The generated transition login is intentionally deterministic and non-secret.
-- Before releasing the login-name UI, use the account-management command/page to
-- replace these values with approved human-facing login names.
UPDATE warehouse_users
SET login_name = CONCAT('user_', LEFT(REPLACE(id, '-', ''), 12));

ALTER TABLE warehouse_users
  MODIFY COLUMN login_name VARCHAR(50) NOT NULL,
  MODIFY COLUMN email VARCHAR(254) NULL,
  ADD UNIQUE KEY uq_warehouse_users_login_name (login_name),
  ADD UNIQUE KEY uq_warehouse_users_phone (phone);

UPDATE warehouse_users u
INNER JOIN warehouse_memberships m ON m.user_id = u.id
SET u.platform_role = 'SYSTEM_ADMIN'
WHERE m.role = 'ADMIN' AND m.membership_status = 'ACTIVE';

ALTER TABLE warehouse_memberships
  ADD COLUMN employee_no VARCHAR(64) NULL AFTER user_id,
  ADD COLUMN role_id CHAR(36) NULL AFTER role,
  ADD KEY idx_warehouse_memberships_role (role_id, membership_status),
  ADD UNIQUE KEY uq_warehouse_memberships_employee_no (warehouse_id, employee_no),
  ADD CONSTRAINT fk_warehouse_memberships_role FOREIGN KEY (role_id) REFERENCES warehouse_roles(id) ON UPDATE RESTRICT ON DELETE SET NULL;

UPDATE warehouse_memberships
SET role_id = CASE
  WHEN role = 'OPERATOR' THEN '00000000-0000-4000-8000-000000000101'
  ELSE '00000000-0000-4000-8000-000000000102'
END;

ALTER TABLE warehouse_sessions
  MODIFY COLUMN warehouse_id CHAR(36) NULL,
  MODIFY COLUMN membership_id CHAR(36) NULL,
  ADD COLUMN absolute_expires_at DATETIME(3) NULL AFTER expires_at;

UPDATE warehouse_sessions
SET absolute_expires_at = DATE_ADD(created_at, INTERVAL 16 HOUR);

ALTER TABLE warehouse_sessions
  MODIFY COLUMN absolute_expires_at DATETIME(3) NOT NULL;

ALTER TABLE print_attempts
  DROP FOREIGN KEY fk_print_attempts_user,
  MODIFY COLUMN user_id CHAR(36) NULL,
  ADD COLUMN actor_reference VARCHAR(64) NULL AFTER user_id,
  ADD CONSTRAINT fk_print_attempts_user FOREIGN KEY (user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL;

UPDATE print_attempts
SET actor_reference = CONCAT('user:', user_id)
WHERE actor_reference IS NULL;

ALTER TABLE print_attempts
  MODIFY COLUMN actor_reference VARCHAR(64) NOT NULL;

CREATE TABLE warehouse_security_audit_events (
  id CHAR(36) NOT NULL,
  event_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  outcome ENUM('SUCCESS', 'DENIED', 'FAILED') NOT NULL,
  actor_user_id CHAR(36) NULL,
  actor_reference VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_id CHAR(36) NULL,
  target_reference VARCHAR(128) NOT NULL,
  warehouse_id CHAR(36) NULL,
  request_id VARCHAR(64) NOT NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  reason VARCHAR(512) NULL,
  change_data JSON NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_warehouse_security_audit_occurred (occurred_at DESC),
  KEY idx_warehouse_security_audit_actor (actor_user_id, occurred_at DESC),
  KEY idx_warehouse_security_audit_target (target_type, target_id, occurred_at DESC),
  CONSTRAINT fk_warehouse_security_audit_actor FOREIGN KEY (actor_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_warehouse_security_audit_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE SET NULL
) ENGINE=InnoDB;

GRANT SELECT, INSERT, UPDATE, DELETE ON cmhub.warehouse_users TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON cmhub.warehouse_memberships TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON cmhub.warehouse_sessions TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT ON cmhub.warehouse_permissions TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON cmhub.warehouse_roles TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, DELETE ON cmhub.warehouse_role_permissions TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.warehouse_security_audit_events TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, UPDATE ON cmhub.print_attempts TO 'cmhub_api'@'127.0.0.1';
FLUSH PRIVILEGES;
