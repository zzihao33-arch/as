-- Configurable paid-time deductions; existing payroll snapshots remain unchanged.
USE cmhub;

CREATE TABLE attendance_payroll_break_rules (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  employee_reference VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  effective_from DATE NOT NULL,
  created_by_reference VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_payroll_break_effective (warehouse_id, employee_reference, effective_from),
  CONSTRAINT fk_payroll_break_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  CHECK (start_time >= '00:00:00' AND end_time < '24:00:00' AND end_time > start_time)
) ENGINE=InnoDB;

ALTER TABLE attendance_payroll_run_rows ADD COLUMN daily_details_snapshot JSON NULL;
