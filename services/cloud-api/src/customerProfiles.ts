import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { ApiError } from './errors.js';
import type { WarehouseSession } from './warehouseIdentity.js';

type CustomerType = 'BUSINESS' | 'UPSTREAM';
type CustomerStatus = 'ACTIVE' | 'DISABLED';
type IntegrationStatus = 'NOT_APPLICABLE' | 'PENDING' | 'INTEGRATING' | 'INTEGRATED' | 'SUSPENDED';

type CustomerRow = RowDataPacket & {
  id: string;
  customer_code: string;
  display_name: string;
  customer_type: CustomerType;
  customer_status: CustomerStatus;
  integration_status: IntegrationStatus;
  integration_client_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  created_at: Date;
  updated_at: Date;
};

const CODE_PATTERN = /^[A-Za-z0-9_-]{2,64}$/;

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `${field} 为必填项`);
  const result = value.trim();
  if (!result || result.length > maximum) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 长度无效`);
  return result;
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, field, maximum);
}

function customerCode(value: unknown): string {
  const result = requiredText(value, 'customerCode', 64).toUpperCase();
  if (!CODE_PATTERN.test(result)) throw new ApiError(400, 'VALIDATION_ERROR', '客户编码仅支持字母、数字、连字符和下划线');
  return result;
}

function customerType(value: unknown): CustomerType {
  if (value === 'BUSINESS' || value === 'UPSTREAM') return value;
  throw new ApiError(400, 'VALIDATION_ERROR', 'customerType 仅支持 BUSINESS 或 UPSTREAM');
}

function customerStatus(value: unknown): CustomerStatus {
  if (value === 'ACTIVE' || value === 'DISABLED') return value;
  throw new ApiError(400, 'VALIDATION_ERROR', 'customerStatus 仅支持 ACTIVE 或 DISABLED');
}

function integrationStatus(value: unknown): Exclude<IntegrationStatus, 'NOT_APPLICABLE' | 'INTEGRATED' | 'SUSPENDED'> {
  if (value === 'PENDING' || value === 'INTEGRATING') return value;
  throw new ApiError(400, 'VALIDATION_ERROR', '上游客户仅可手工设置为待对接或对接中；已对接状态由集成身份激活');
}

function view(row: CustomerRow) {
  return {
    id: row.id,
    code: row.customer_code,
    name: row.display_name,
    type: row.customer_type,
    status: row.customer_status,
    integrationStatus: row.integration_status,
    integrationClientId: row.integration_client_id,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function actor(session: WarehouseSession): string {
  return `user:${session.userId}`;
}

export function createCustomerProfiles(dependencies: { mysql: Pool }) {
  const { mysql } = dependencies;
  return {
    async list(input: { type?: unknown; includeDisabled?: boolean } = {}) {
      const type = input.type === undefined || input.type === '' ? null : customerType(input.type);
      const [rows] = await mysql.execute<CustomerRow[]>(
        `SELECT * FROM customer_profiles
         WHERE (? IS NULL OR customer_type = ?)
           AND (? = TRUE OR customer_status = 'ACTIVE')
         ORDER BY display_name, customer_code`,
        [type, type, Boolean(input.includeDisabled)],
      );
      return rows.map(view);
    },

    async create(session: WarehouseSession, input: Record<string, unknown>) {
      const id = randomUUID();
      const code = customerCode(input.customerCode);
      const name = requiredText(input.name, 'name', 128);
      const type = customerType(input.type);
      const contactName = optionalText(input.contactName, 'contactName', 100);
      const contactPhone = optionalText(input.contactPhone, 'contactPhone', 32);
      const contactEmail = optionalText(input.contactEmail, 'contactEmail', 254);
      const integration = type === 'UPSTREAM'
        ? (input.integrationStatus === undefined ? 'PENDING' : integrationStatus(input.integrationStatus))
        : 'NOT_APPLICABLE';
      try {
        await mysql.execute(
          `INSERT INTO customer_profiles
            (id, customer_code, display_name, customer_type, integration_status,
             contact_name, contact_phone, contact_email, created_by_user_id, created_by_reference,
             updated_by_user_id, updated_by_reference)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, code, name, type, integration, contactName, contactPhone, contactEmail,
            session.userId, actor(session), session.userId, actor(session)],
        );
        await mysql.execute(
          `INSERT INTO customer_profile_events
            (customer_profile_id, event_type, actor_user_id, actor_reference, event_data)
           VALUES (?, 'CUSTOMER_CREATED', ?, ?, ?)`,
          [id, session.userId, actor(session), JSON.stringify({ code, name, type, integrationStatus: integration })],
        );
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ER_DUP_ENTRY') {
          throw new ApiError(409, 'CUSTOMER_CODE_EXISTS', '客户编码已存在，请使用其他编码');
        }
        throw error;
      }
      const [rows] = await mysql.execute<CustomerRow[]>('SELECT * FROM customer_profiles WHERE id = ? LIMIT 1', [id]);
      return view(rows[0]!);
    },

    async update(session: WarehouseSession, customerId: string, input: Record<string, unknown>) {
      const [rows] = await mysql.execute<CustomerRow[]>('SELECT * FROM customer_profiles WHERE id = ? LIMIT 1', [customerId]);
      const current = rows[0];
      if (!current) throw new ApiError(404, 'CUSTOMER_NOT_FOUND', '未找到客户档案');
      const nextName = input.name === undefined ? current.display_name : requiredText(input.name, 'name', 128);
      const nextStatus = input.status === undefined ? current.customer_status : customerStatus(input.status);
      const nextContactName = input.contactName === undefined ? current.contact_name : optionalText(input.contactName, 'contactName', 100);
      const nextContactPhone = input.contactPhone === undefined ? current.contact_phone : optionalText(input.contactPhone, 'contactPhone', 32);
      const nextContactEmail = input.contactEmail === undefined ? current.contact_email : optionalText(input.contactEmail, 'contactEmail', 254);
      const nextIntegration = current.customer_type === 'UPSTREAM' && input.integrationStatus !== undefined
        ? integrationStatus(input.integrationStatus) : current.integration_status;
      if (current.integration_client_id && nextIntegration !== 'INTEGRATED') {
        throw new ApiError(409, 'INTEGRATION_ALREADY_CONNECTED', '已绑定集成身份的上游客户不能手工改回未对接状态');
      }
      await mysql.execute(
        `UPDATE customer_profiles
         SET display_name = ?, customer_status = ?, integration_status = ?, contact_name = ?, contact_phone = ?, contact_email = ?,
             updated_by_user_id = ?, updated_by_reference = ? WHERE id = ?`,
        [nextName, nextStatus, nextIntegration, nextContactName, nextContactPhone, nextContactEmail,
          session.userId, actor(session), customerId],
      );
      await mysql.execute(
        `INSERT INTO customer_profile_events
          (customer_profile_id, event_type, actor_user_id, actor_reference, event_data)
         VALUES (?, 'CUSTOMER_UPDATED', ?, ?, ?)`,
        [customerId, session.userId, actor(session), JSON.stringify({ name: nextName, status: nextStatus, integrationStatus: nextIntegration })],
      );
      const [updated] = await mysql.execute<CustomerRow[]>('SELECT * FROM customer_profiles WHERE id = ? LIMIT 1', [customerId]);
      return view(updated[0]!);
    },

    async remove(customerId: string) {
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [profiles] = await connection.execute<CustomerRow[]>(
          'SELECT * FROM customer_profiles WHERE id = ? LIMIT 1 FOR UPDATE', [customerId],
        );
        const profile = profiles[0];
        if (!profile) throw new ApiError(404, 'CUSTOMER_NOT_FOUND', '未找到客户档案');
        if (profile.integration_client_id) {
          throw new ApiError(409, 'CUSTOMER_INTEGRATION_CONNECTED', '已绑定系统对接的上游客户不能删除');
        }
        const [orders] = await connection.execute<(RowDataPacket & { id: string })[]>(
          'SELECT id FROM air_pickup_orders WHERE customer_profile_id = ? LIMIT 1 FOR UPDATE', [customerId],
        );
        if (orders[0]) throw new ApiError(409, 'CUSTOMER_IN_USE', '该客户已有提货单记录，不能删除');
        await connection.execute('DELETE FROM customer_profile_events WHERE customer_profile_id = ?', [customerId]);
        await connection.execute('DELETE FROM customer_profiles WHERE id = ?', [customerId]);
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally { connection.release(); }
    },
  };
}
