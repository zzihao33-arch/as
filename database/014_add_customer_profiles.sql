-- CM-HUB: separate operational customer master data from API integration identities.
-- Business customers never integrate. Upstream customers may be created before their API integration is ready.

CREATE TABLE customer_profiles (
  id CHAR(36) NOT NULL,
  customer_code VARCHAR(64) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  customer_type ENUM('BUSINESS', 'UPSTREAM') NOT NULL,
  customer_status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  integration_status ENUM('NOT_APPLICABLE', 'PENDING', 'INTEGRATING', 'INTEGRATED', 'SUSPENDED') NOT NULL DEFAULT 'NOT_APPLICABLE',
  integration_client_id CHAR(36) NULL,
  contact_name VARCHAR(100) NULL,
  contact_phone VARCHAR(32) NULL,
  contact_email VARCHAR(254) NULL,
  created_by_user_id CHAR(36) NULL,
  created_by_reference VARCHAR(64) NOT NULL,
  updated_by_user_id CHAR(36) NULL,
  updated_by_reference VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_profiles_code (customer_code),
  UNIQUE KEY uq_customer_profiles_integration_client (integration_client_id),
  KEY idx_customer_profiles_active (customer_status, customer_type, display_name),
  CONSTRAINT fk_customer_profiles_integration_client FOREIGN KEY (integration_client_id) REFERENCES clients(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_customer_profiles_creator FOREIGN KEY (created_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CONSTRAINT fk_customer_profiles_updater FOREIGN KEY (updated_by_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK ((customer_type = 'BUSINESS' AND integration_status = 'NOT_APPLICABLE' AND integration_client_id IS NULL)
    OR (customer_type = 'UPSTREAM' AND integration_status <> 'NOT_APPLICABLE'))
) ENGINE=InnoDB;

CREATE TABLE customer_profile_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_profile_id CHAR(36) NOT NULL,
  event_type ENUM('CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'INTEGRATION_CONNECTED') NOT NULL,
  actor_user_id CHAR(36) NULL,
  actor_reference VARCHAR(64) NOT NULL,
  event_data JSON NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_customer_profile_events_profile (customer_profile_id, occurred_at DESC),
  CONSTRAINT fk_customer_profile_events_profile FOREIGN KEY (customer_profile_id) REFERENCES customer_profiles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_customer_profile_events_actor FOREIGN KEY (actor_user_id) REFERENCES warehouse_users(id) ON UPDATE RESTRICT ON DELETE SET NULL
) ENGINE=InnoDB;

-- Every existing API integration client becomes an already-integrated upstream customer.
INSERT INTO customer_profiles
  (id, customer_code, display_name, customer_type, customer_status, integration_status,
   integration_client_id, created_by_reference, updated_by_reference, created_at, updated_at)
SELECT id, client_code, display_name, 'UPSTREAM',
  CASE WHEN client_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'DISABLED' END,
  CASE WHEN client_status = 'ACTIVE' THEN 'INTEGRATED' ELSE 'SUSPENDED' END,
  id, 'migration:014', 'migration:014', created_at, updated_at
FROM clients;

ALTER TABLE air_pickup_orders
  ADD COLUMN customer_profile_id CHAR(36) NULL AFTER client_id,
  ADD COLUMN customer_name_snapshot VARCHAR(128) NULL AFTER client_name_snapshot,
  ADD COLUMN customer_type_snapshot ENUM('BUSINESS', 'UPSTREAM') NULL AFTER customer_name_snapshot,
  ADD KEY idx_air_pickup_customer_updated (customer_profile_id, updated_at DESC),
  ADD CONSTRAINT fk_air_pickup_orders_customer_profile FOREIGN KEY (customer_profile_id) REFERENCES customer_profiles(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

UPDATE air_pickup_orders o
INNER JOIN customer_profiles p ON p.integration_client_id = o.client_id
SET o.customer_profile_id = p.id,
    o.customer_name_snapshot = p.display_name,
    o.customer_type_snapshot = p.customer_type
WHERE o.customer_profile_id IS NULL;

INSERT INTO warehouse_permissions (permission_code, module_code, display_name, risk_level) VALUES
  ('customers.view', 'customers', '查看客户档案', 'LOW'),
  ('customers.manage', 'customers', '新增和维护客户档案', 'HIGH');

INSERT INTO warehouse_role_permissions (role_id, permission_code)
SELECT '00000000-0000-4000-8000-000000000102', permission_code
FROM warehouse_permissions
WHERE module_code = 'customers';
