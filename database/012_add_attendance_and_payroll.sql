-- CM-HUB: cloud attendance capture, supervisor-reviewed corrections,
-- effective-dated shift/pay rules, and immutable payroll calculation snapshots.
-- Apply once after 011_link_air_pickups_clients_shipments_and_receipt_evidence.sql on MySQL 8.0.

USE cmhub;

INSERT INTO warehouse_permissions (permission_code, module_code, display_name, risk_level) VALUES
  ('attendance.punch', 'attendance', '提交本人考勤打卡', 'MEDIUM'),
  ('attendance.self_view', 'attendance', '查看本人考勤记录', 'LOW'),
  ('attendance.appeal', 'attendance', '提交本人考勤例外申请', 'MEDIUM'),
  ('attendance.team_view', 'attendance', '查看仓库考勤记录', 'HIGH'),
  ('attendance.review', 'attendance', '审批考勤例外申请', 'HIGH'),
  ('attendance.locations.manage', 'attendance', '管理仓库打卡地点', 'HIGH'),
  ('attendance.rules.manage', 'attendance', '管理班次与薪酬规则', 'HIGH');

INSERT INTO warehouse_role_permissions (role_id, permission_code)
SELECT '00000000-0000-4000-8000-000000000101', permission_code
FROM warehouse_permissions
WHERE permission_code IN ('attendance.punch', 'attendance.self_view', 'attendance.appeal');

INSERT INTO warehouse_role_permissions (role_id, permission_code)
SELECT '00000000-0000-4000-8000-000000000102', permission_code
FROM warehouse_permissions
WHERE permission_code IN (
  'attendance.punch', 'attendance.self_view', 'attendance.appeal',
  'attendance.team_view', 'attendance.review',
  'attendance.locations.manage', 'attendance.rules.manage'
);

CREATE TABLE attendance_locations (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  location_name VARCHAR(128) NOT NULL,
  address_text VARCHAR(255) NULL,
  latitude DECIMAL(10, 7) NOT NULL,
  longitude DECIMAL(10, 7) NOT NULL,
  radius_meters SMALLINT UNSIGNED NOT NULL DEFAULT 200,
  location_status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id CHAR(36) NULL,
  created_by_reference VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_attendance_locations_warehouse_status (warehouse_id, location_status),
  CONSTRAINT fk_attendance_locations_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_locations_creator FOREIGN KEY (created_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (latitude BETWEEN -90 AND 90),
  CHECK (longitude BETWEEN -180 AND 180),
  CHECK (radius_meters BETWEEN 50 AND 1000)
) ENGINE=InnoDB;

CREATE TABLE attendance_shift_rules (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  rule_name VARCHAR(128) NOT NULL,
  time_zone VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'America/New_York',
  weekdays JSON NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  late_grace_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  early_grace_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  rule_status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  rule_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by_user_id CHAR(36) NULL,
  created_by_reference VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_attendance_shift_rules_effective (warehouse_id, rule_status, effective_from, effective_to),
  CONSTRAINT fk_attendance_shift_rules_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_shift_rules_creator FOREIGN KEY (created_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (JSON_VALID(weekdays)),
  CHECK (late_grace_minutes <= 240),
  CHECK (early_grace_minutes <= 240),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
) ENGINE=InnoDB;

CREATE TABLE attendance_punch_attempts (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  employee_reference VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  employee_name_snapshot VARCHAR(128) NOT NULL,
  employee_no_snapshot VARCHAR(64) NULL,
  workstation_id CHAR(36) NULL,
  punch_type ENUM('IN', 'OUT') NOT NULL,
  channel ENUM('MOBILE', 'WORKSTATION') NOT NULL,
  attempt_result ENUM('ACCEPTED', 'REJECTED', 'EXCEPTION_REQUIRED') NOT NULL,
  reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  reason_text VARCHAR(512) NULL,
  server_received_at DATETIME(3) NOT NULL,
  client_captured_at DATETIME(3) NULL,
  location_latitude DECIMAL(10, 7) NULL,
  location_longitude DECIMAL(10, 7) NULL,
  location_accuracy_meters DECIMAL(8, 2) NULL,
  matched_location_id CHAR(36) NULL,
  distance_meters DECIMAL(10, 2) NULL,
  gesture_type ENUM('BLINK', 'MOUTH_OPEN') NULL,
  gesture_passed BOOLEAN NULL,
  gesture_score DECIMAL(7, 4) NULL,
  photo_storage_key VARCHAR(512) NULL,
  photo_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  photo_content_type ENUM('image/jpeg', 'image/png') NULL,
  photo_byte_size INT UNSIGNED NULL,
  photo_width SMALLINT UNSIGNED NULL,
  photo_height SMALLINT UNSIGNED NULL,
  evidence_delete_after DATETIME(3) NOT NULL,
  request_id VARCHAR(64) NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_attendance_attempts_employee_time (employee_reference, server_received_at DESC),
  KEY idx_attendance_attempts_warehouse_time (warehouse_id, server_received_at DESC),
  KEY idx_attendance_attempts_evidence_retention (evidence_delete_after, photo_storage_key),
  CONSTRAINT fk_attendance_attempts_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_attempts_user FOREIGN KEY (user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_attendance_attempts_workstation FOREIGN KEY (workstation_id) REFERENCES workstations(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_attendance_attempts_location FOREIGN KEY (matched_location_id) REFERENCES attendance_locations(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (photo_sha256 IS NULL OR photo_sha256 REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB;

CREATE TABLE attendance_punches (
  id CHAR(36) NOT NULL,
  attempt_id CHAR(36) NULL,
  warehouse_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  employee_reference VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  employee_name_snapshot VARCHAR(128) NOT NULL,
  employee_no_snapshot VARCHAR(64) NULL,
  punch_type ENUM('IN', 'OUT') NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  work_date DATE NOT NULL,
  punch_source ENUM('NORMAL', 'APPEAL_CORRECTION') NOT NULL,
  punch_status ENUM('ACTIVE', 'SUPERSEDED') NOT NULL DEFAULT 'ACTIVE',
  superseded_by_id CHAR(36) NULL,
  created_by_user_id CHAR(36) NULL,
  created_by_reference VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_attendance_punches_attempt (attempt_id),
  KEY idx_attendance_punches_employee_date (employee_reference, work_date, punch_status, punch_type),
  KEY idx_attendance_punches_warehouse_date (warehouse_id, work_date, punch_status),
  CONSTRAINT fk_attendance_punches_attempt FOREIGN KEY (attempt_id) REFERENCES attendance_punch_attempts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_punches_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_punches_user FOREIGN KEY (user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_attendance_punches_creator FOREIGN KEY (created_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_attendance_punches_superseded FOREIGN KEY (superseded_by_id) REFERENCES attendance_punches(id) ON UPDATE RESTRICT ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE attendance_daily_results (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  employee_reference VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  employee_name_snapshot VARCHAR(128) NOT NULL,
  employee_no_snapshot VARCHAR(64) NULL,
  work_date DATE NOT NULL,
  clock_in_punch_id CHAR(36) NULL,
  clock_out_punch_id CHAR(36) NULL,
  clock_in_at DATETIME(3) NULL,
  clock_out_at DATETIME(3) NULL,
  gross_minutes INT UNSIGNED NOT NULL DEFAULT 0,
  net_minutes INT UNSIGNED NOT NULL DEFAULT 0,
  result_status ENUM('OPEN', 'COMPLETE', 'MISSING_IN', 'MISSING_OUT', 'ABSENT', 'NEEDS_REVIEW') NOT NULL,
  is_late BOOLEAN NOT NULL DEFAULT FALSE,
  is_early_leave BOOLEAN NOT NULL DEFAULT FALSE,
  shift_rule_id CHAR(36) NULL,
  scheduled_start_snapshot TIME NULL,
  scheduled_end_snapshot TIME NULL,
  late_grace_minutes_snapshot SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  early_grace_minutes_snapshot SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  result_version INT UNSIGNED NOT NULL DEFAULT 1,
  calculated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_attendance_daily_employee_date (warehouse_id, employee_reference, work_date),
  KEY idx_attendance_daily_warehouse_date (warehouse_id, work_date, result_status),
  CONSTRAINT fk_attendance_daily_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_daily_user FOREIGN KEY (user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_attendance_daily_in FOREIGN KEY (clock_in_punch_id) REFERENCES attendance_punches(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_attendance_daily_out FOREIGN KEY (clock_out_punch_id) REFERENCES attendance_punches(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_attendance_daily_rule FOREIGN KEY (shift_rule_id) REFERENCES attendance_shift_rules(id) ON UPDATE RESTRICT ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE attendance_appeals (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  employee_reference VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  employee_name_snapshot VARCHAR(128) NOT NULL,
  employee_no_snapshot VARCHAR(64) NULL,
  work_date DATE NOT NULL,
  appeal_type ENUM('DEVICE_FAILURE', 'TEMPORARY_LEAVE', 'OTHER') NOT NULL,
  requested_clock_in_at DATETIME(3) NULL,
  requested_clock_out_at DATETIME(3) NULL,
  description VARCHAR(200) NOT NULL,
  appeal_status ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  review_note VARCHAR(500) NULL,
  reviewed_by_user_id CHAR(36) NULL,
  reviewed_by_reference VARCHAR(64) NULL,
  reviewed_at DATETIME(3) NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_attendance_appeals_warehouse_status (warehouse_id, appeal_status, created_at DESC),
  KEY idx_attendance_appeals_employee (employee_reference, created_at DESC),
  CONSTRAINT fk_attendance_appeals_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_appeals_user FOREIGN KEY (user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_attendance_appeals_reviewer FOREIGN KEY (reviewed_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE attendance_pay_profiles (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  employee_reference VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  employee_name_snapshot VARCHAR(128) NOT NULL,
  employee_no_snapshot VARCHAR(64) NULL,
  hourly_rate DECIMAL(10, 2) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  created_by_user_id CHAR(36) NULL,
  created_by_reference VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_attendance_pay_profile_effective (warehouse_id, employee_reference, effective_from),
  KEY idx_attendance_pay_profile_lookup (warehouse_id, employee_reference, effective_from DESC, effective_to),
  CONSTRAINT fk_attendance_pay_profiles_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_pay_profiles_user FOREIGN KEY (user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_attendance_pay_profiles_creator FOREIGN KEY (created_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (hourly_rate > 0),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
) ENGINE=InnoDB;

CREATE TABLE attendance_payroll_adjustments (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  employee_reference VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  bonus DECIMAL(12, 2) NOT NULL DEFAULT 0,
  fuel_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  note VARCHAR(500) NULL,
  updated_by_user_id CHAR(36) NULL,
  updated_by_reference VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_attendance_payroll_adjustment (warehouse_id, employee_reference, period_start, period_end),
  CONSTRAINT fk_attendance_payroll_adjustments_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_payroll_adjustments_updater FOREIGN KEY (updated_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (period_end >= period_start),
  CHECK (bonus >= 0)
) ENGINE=InnoDB;

CREATE TABLE attendance_payroll_runs (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  rule_snapshot JSON NOT NULL,
  employee_count INT UNSIGNED NOT NULL,
  total_regular_minutes BIGINT UNSIGNED NOT NULL,
  total_overtime_minutes BIGINT UNSIGNED NOT NULL,
  total_pay DECIMAL(14, 2) NOT NULL,
  created_by_user_id CHAR(36) NULL,
  created_by_reference VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_attendance_payroll_runs_period (warehouse_id, period_start, period_end, created_at DESC),
  CONSTRAINT fk_attendance_payroll_runs_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_payroll_runs_creator FOREIGN KEY (created_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (period_end >= period_start),
  CHECK (JSON_VALID(rule_snapshot))
) ENGINE=InnoDB;

CREATE TABLE attendance_payroll_run_rows (
  id CHAR(36) NOT NULL,
  payroll_run_id CHAR(36) NOT NULL,
  employee_reference VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  employee_name_snapshot VARCHAR(128) NOT NULL,
  employee_no_snapshot VARCHAR(64) NULL,
  hourly_rate DECIMAL(10, 2) NULL,
  regular_minutes INT UNSIGNED NOT NULL,
  overtime_minutes INT UNSIGNED NOT NULL,
  regular_pay DECIMAL(12, 2) NULL,
  overtime_pay DECIMAL(12, 2) NULL,
  bonus DECIMAL(12, 2) NOT NULL DEFAULT 0,
  fuel_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  fuel_allowance DECIMAL(12, 2) NOT NULL DEFAULT 0,
  total_pay DECIMAL(12, 2) NULL,
  calculation_issues JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_attendance_payroll_run_employee (payroll_run_id, employee_reference),
  CONSTRAINT fk_attendance_payroll_rows_run FOREIGN KEY (payroll_run_id) REFERENCES attendance_payroll_runs(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CHECK (JSON_VALID(calculation_issues))
) ENGINE=InnoDB;

GRANT SELECT, INSERT, UPDATE ON cmhub.attendance_locations TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.attendance_shift_rules TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.attendance_punch_attempts TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.attendance_punches TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.attendance_daily_results TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.attendance_appeals TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.attendance_pay_profiles TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON cmhub.attendance_payroll_adjustments TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT ON cmhub.attendance_payroll_runs TO 'cmhub_api'@'127.0.0.1';
GRANT SELECT, INSERT ON cmhub.attendance_payroll_run_rows TO 'cmhub_api'@'127.0.0.1';
FLUSH PRIVILEGES;
