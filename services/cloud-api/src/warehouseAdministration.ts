import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { ApiError } from './errors.js';
import type { WarehouseSession } from './warehouseIdentity.js';
import { hashWarehousePassword } from './warehouseSecurity.js';
import { WAREHOUSE_PERMISSION_CODES, type WarehousePermission } from './warehouseAccess.js';

type RequestAudit = { requestId: string; ip: string; userAgent?: string };
type AccountRow = RowDataPacket & {
  id: string;
  login_name: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  user_status: 'ACTIVE' | 'DISABLED';
  platform_role: 'SYSTEM_ADMIN' | null;
  password_state: 'ACTIVE' | 'CHANGE_REQUIRED';
  last_login_at: Date | null;
  created_at: Date;
  warehouse_id: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  membership_id: string | null;
  employee_no: string | null;
  membership_status: 'ACTIVE' | 'DISABLED' | null;
  role_id: string | null;
  role_name: string | null;
  total_count: number | string;
};
type RoleRow = RowDataPacket & {
  id: string;
  role_code: string;
  role_name: string;
  role_description: string | null;
  role_kind: 'DEFAULT' | 'CUSTOM';
  role_version: number;
  employee_count: number | string;
  permissions: string | null;
  created_at: Date;
  updated_at: Date;
};
type PermissionRow = RowDataPacket & {
  permission_code: WarehousePermission;
  module_code: string;
  display_name: string;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
};
type AuditRow = RowDataPacket & {
  id: string;
  event_type: string;
  outcome: string;
  actor_reference: string;
  target_type: string;
  target_reference: string;
  warehouse_id: string | null;
  request_id: string;
  ip_address: string | null;
  reason: string | null;
  change_data: unknown;
  occurred_at: Date;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value: unknown, field: string, maxLength: number, required = true): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 为必填项。`);
    return null;
  }
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是字符串。`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 长度无效。`);
  return normalized;
}

function uuid(value: unknown, field: string): string {
  const result = text(value, field, 36)!;
  if (!UUID_PATTERN.test(result)) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是 UUID。`);
  return result;
}

function loginName(value: unknown): string {
  const result = text(value, 'loginName', 50)!.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,49}$/.test(result)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '账号需为 3–50 位字母、数字、点、下划线或连字符。');
  }
  return result;
}

function pageValue(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ApiError(400, 'VALIDATION_ERROR', `分页参数必须是 1 到 ${maximum} 的整数。`);
  }
  return parsed;
}

function temporaryPassword(): string {
  return `Cmh!${randomBytes(18).toString('base64url')}`;
}

function anonymizedActor(userId: string): string {
  return `deleted:${createHash('sha256').update(userId).digest('hex').slice(0, 24)}`;
}

async function audit(
  connection: PoolConnection,
  session: WarehouseSession,
  request: RequestAudit,
  input: {
    eventType: string;
    outcome?: 'SUCCESS' | 'DENIED' | 'FAILED';
    targetType: string;
    targetId?: string | null;
    targetReference: string;
    reason?: string | null;
    changeData?: unknown;
  },
): Promise<void> {
  await connection.execute(
    `INSERT INTO warehouse_security_audit_events
       (id, event_type, outcome, actor_user_id, actor_reference, target_type, target_id,
        target_reference, warehouse_id, request_id, ip_address, user_agent, reason, change_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), input.eventType, input.outcome ?? 'SUCCESS', session.userId,
      `user:${session.userId}`, input.targetType, input.targetId ?? null, input.targetReference,
      session.warehouseId, request.requestId, request.ip.slice(0, 64), request.userAgent?.slice(0, 512) ?? null,
      input.reason ?? null, input.changeData === undefined ? null : JSON.stringify(input.changeData)],
  );
}

export function createWarehouseAdministration(dependencies: { mysql: Pool }) {
  const { mysql } = dependencies;

  return {
    async listAccounts(input: { search?: unknown; status?: unknown; roleId?: unknown; page?: unknown; pageSize?: unknown }) {
      const search = input.search === undefined || input.search === '' ? null : text(input.search, 'search', 100);
      const status = input.status === undefined || input.status === '' ? null : text(input.status, 'status', 16);
      if (status && !['ACTIVE', 'DISABLED'].includes(status)) throw new ApiError(400, 'VALIDATION_ERROR', 'status 不受支持。');
      const roleId = input.roleId === undefined || input.roleId === '' ? null : uuid(input.roleId, 'roleId');
      const page = pageValue(input.page, 1, 100_000);
      const pageSize = pageValue(input.pageSize, 20, 100);
      const offset = (page - 1) * pageSize;
      const searchPattern = search ? `%${search}%` : null;
      const [rows] = await mysql.execute<AccountRow[]>(
        `WITH filtered_users AS (
           SELECT u.id, u.login_name, u.display_name, u.email, u.phone, u.user_status, u.platform_role,
                  u.password_state, u.last_login_at, u.created_at, COUNT(*) OVER () AS total_count
           FROM warehouse_users u
           WHERE (? IS NULL OR u.login_name LIKE ? OR u.display_name LIKE ? OR u.phone LIKE ?
             OR EXISTS (SELECT 1 FROM warehouse_memberships sm WHERE sm.user_id = u.id AND sm.employee_no LIKE ?))
             AND (? IS NULL OR u.user_status = ?)
             AND (? IS NULL OR EXISTS (SELECT 1 FROM warehouse_memberships rm WHERE rm.user_id = u.id AND rm.role_id = ?))
           ORDER BY u.created_at DESC, u.id
           LIMIT ${pageSize} OFFSET ${offset}
         )
         SELECT u.id, u.login_name, u.display_name, u.email, u.phone, u.user_status, u.platform_role,
                u.password_state, u.last_login_at, u.created_at, u.total_count,
                w.id AS warehouse_id, w.warehouse_code, w.display_name AS warehouse_name,
                m.id AS membership_id, m.employee_no, m.membership_status,
                r.id AS role_id, r.role_name
         FROM filtered_users u
         LEFT JOIN warehouse_memberships m ON m.user_id = u.id
         LEFT JOIN warehouses w ON w.id = m.warehouse_id
         LEFT JOIN warehouse_roles r ON r.id = m.role_id
         ORDER BY u.created_at DESC, u.id, w.display_name`,
        [searchPattern, searchPattern, searchPattern, searchPattern, searchPattern,
          status, status, roleId, roleId],
      );
      const accounts = new Map<string, {
        id: string; loginName: string; displayName: string; email: string | null; phone: string | null;
        status: string; platformRole: string | null; passwordState: string; lastLoginAt: string | null;
        createdAt: string; memberships: Array<Record<string, unknown>>;
      }>();
      for (const row of rows) {
        const account = accounts.get(row.id) ?? {
          id: row.id,
          loginName: row.login_name,
          displayName: row.display_name,
          email: row.email,
          phone: row.phone,
          status: row.user_status,
          platformRole: row.platform_role,
          passwordState: row.password_state,
          lastLoginAt: row.last_login_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
          memberships: [],
        };
        if (row.membership_id) account.memberships.push({
          id: row.membership_id,
          warehouseId: row.warehouse_id,
          warehouseCode: row.warehouse_code,
          warehouseName: row.warehouse_name,
          employeeNo: row.employee_no,
          status: row.membership_status,
          roleId: row.role_id,
          roleName: row.role_name,
        });
        accounts.set(row.id, account);
      }
      return { accounts: [...accounts.values()], total: Number(rows[0]?.total_count ?? 0), page, pageSize };
    },

    async createAccount(session: WarehouseSession, request: RequestAudit, input: Record<string, unknown>) {
      const nextLoginName = loginName(input.loginName);
      const displayName = text(input.displayName, 'displayName', 128)!;
      const phone = text(input.phone, 'phone', 32, false);
      const email = text(input.email, 'email', 254, false)?.toLowerCase() ?? null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'VALIDATION_ERROR', 'email 格式无效。');
      const warehouseId = uuid(input.warehouseId, 'warehouseId');
      const roleId = uuid(input.roleId, 'roleId');
      const employeeNo = text(input.employeeNo, 'employeeNo', 64, false);
      const password = temporaryPassword();
      const passwordHash = await hashWarehousePassword(password);
      const userId = randomUUID();
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [existing] = await connection.execute<(RowDataPacket & { id: string })[]>(
          `SELECT id FROM warehouse_users
           WHERE login_name = ? OR (? IS NOT NULL AND phone = ?) OR (? IS NOT NULL AND email = ?)
           LIMIT 1 FOR UPDATE`,
          [nextLoginName, phone, phone, email, email],
        );
        if (existing[0]) throw new ApiError(409, 'ACCOUNT_ALREADY_EXISTS', '账号、手机号或邮箱已被使用。');
        const [targets] = await connection.execute<(RowDataPacket & { warehouse_id: string; role_id: string })[]>(
          `SELECT w.id AS warehouse_id, r.id AS role_id
           FROM warehouses w CROSS JOIN warehouse_roles r
           WHERE w.id = ? AND w.warehouse_status = 'ACTIVE' AND r.id = ? LIMIT 1`,
          [warehouseId, roleId],
        );
        if (!targets[0]) throw new ApiError(400, 'INVALID_ACCOUNT_ASSIGNMENT', '仓库或角色不存在。');
        await connection.execute(
          `INSERT INTO warehouse_users
             (id, login_name, email, phone, display_name, password_hash, password_state)
           VALUES (?, ?, ?, ?, ?, ?, 'CHANGE_REQUIRED')`,
          [userId, nextLoginName, email, phone, displayName, passwordHash],
        );
        await connection.execute(
          `INSERT INTO warehouse_memberships
             (id, warehouse_id, user_id, employee_no, role_id, role, membership_status)
           VALUES (?, ?, ?, ?, ?, 'OPERATOR', 'ACTIVE')`,
          [randomUUID(), warehouseId, userId, employeeNo, roleId],
        );
        await audit(connection, session, request, {
          eventType: 'ACCOUNT_CREATED', targetType: 'ACCOUNT', targetId: userId,
          targetReference: nextLoginName, changeData: { displayName, warehouseId, roleId },
        });
        await connection.commit();
        return { id: userId, loginName: nextLoginName, displayName, temporaryPassword: password };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async updateAccount(session: WarehouseSession, request: RequestAudit, accountIdValue: unknown, input: Record<string, unknown>) {
      const accountId = uuid(accountIdValue, 'accountId');
      const nextLoginName = input.loginName === undefined ? null : loginName(input.loginName);
      const displayName = input.displayName === undefined ? null : text(input.displayName, 'displayName', 128);
      const phone = input.phone === undefined ? undefined : text(input.phone, 'phone', 32, false);
      const email = input.email === undefined ? undefined : text(input.email, 'email', 254, false)?.toLowerCase() ?? null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'VALIDATION_ERROR', 'email 格式无效。');
      const status = input.status === undefined ? null : text(input.status, 'status', 16);
      if (status && !['ACTIVE', 'DISABLED'].includes(status)) throw new ApiError(400, 'VALIDATION_ERROR', 'status 不受支持。');
      if (status === 'DISABLED' && accountId === session.userId) {
        throw new ApiError(409, 'CANNOT_DISABLE_CURRENT_ACCOUNT', '不能禁用当前登录账户。');
      }
      if (nextLoginName === null && displayName === null && phone === undefined && email === undefined && status === null) {
        throw new ApiError(400, 'VALIDATION_ERROR', '没有可更新的账户字段。');
      }
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [accounts] = await connection.execute<(RowDataPacket & { login_name: string })[]>(
          `SELECT login_name FROM warehouse_users WHERE id = ? LIMIT 1 FOR UPDATE`, [accountId],
        );
        if (!accounts[0]) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '未找到账户。');
        await connection.execute(
          `UPDATE warehouse_users
           SET login_name = COALESCE(?, login_name), display_name = COALESCE(?, display_name),
               phone = CASE WHEN ? THEN ? ELSE phone END,
               email = CASE WHEN ? THEN ? ELSE email END,
               user_status = COALESCE(?, user_status)
           WHERE id = ?`,
          [nextLoginName, displayName, phone !== undefined, phone ?? null, email !== undefined, email ?? null, status, accountId],
        );
        if (status === 'DISABLED') {
          await connection.execute(
            `UPDATE warehouse_sessions SET revoked_at = CURRENT_TIMESTAMP(3)
             WHERE user_id = ? AND revoked_at IS NULL`,
            [accountId],
          );
        }
        await audit(connection, session, request, {
          eventType: status === 'DISABLED' ? 'ACCOUNT_DISABLED' : status === 'ACTIVE' ? 'ACCOUNT_ENABLED' : 'ACCOUNT_UPDATED',
          targetType: 'ACCOUNT', targetId: accountId, targetReference: accounts[0].login_name,
          changeData: { loginName: nextLoginName, displayName, phone, email, status },
        });
        await connection.commit();
        return { id: accountId };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async assignRole(session: WarehouseSession, request: RequestAudit, accountIdValue: unknown, input: Record<string, unknown>) {
      const accountId = uuid(accountIdValue, 'accountId');
      const warehouseId = uuid(input.warehouseId, 'warehouseId');
      const roleId = uuid(input.roleId, 'roleId');
      const employeeNo = input.employeeNo === undefined ? null : text(input.employeeNo, 'employeeNo', 64, false);
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [target] = await connection.execute<(RowDataPacket & { login_name: string })[]>(
          `SELECT u.login_name FROM warehouse_users u
           INNER JOIN warehouses w ON w.id = ? AND w.warehouse_status = 'ACTIVE'
           INNER JOIN warehouse_roles r ON r.id = ?
           WHERE u.id = ? LIMIT 1 FOR UPDATE`,
          [warehouseId, roleId, accountId],
        );
        if (!target[0]) throw new ApiError(404, 'ACCOUNT_ASSIGNMENT_TARGET_NOT_FOUND', '账户、仓库或角色不存在。');
        await connection.execute(
          `INSERT INTO warehouse_memberships
             (id, warehouse_id, user_id, employee_no, role_id, role, membership_status)
           VALUES (?, ?, ?, ?, ?, 'OPERATOR', 'ACTIVE')
           ON DUPLICATE KEY UPDATE employee_no = VALUES(employee_no), role_id = VALUES(role_id), membership_status = 'ACTIVE'`,
          [randomUUID(), warehouseId, accountId, employeeNo, roleId],
        );
        await audit(connection, session, request, {
          eventType: 'ACCOUNT_ROLE_ASSIGNED', targetType: 'ACCOUNT', targetId: accountId,
          targetReference: target[0].login_name, changeData: { warehouseId, roleId, employeeNo },
        });
        await connection.commit();
        return { id: accountId, warehouseId, roleId };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async resetPassword(session: WarehouseSession, request: RequestAudit, accountIdValue: unknown) {
      const accountId = uuid(accountIdValue, 'accountId');
      const password = temporaryPassword();
      const passwordHash = await hashWarehousePassword(password);
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [accounts] = await connection.execute<(RowDataPacket & { login_name: string })[]>(
          `SELECT login_name FROM warehouse_users WHERE id = ? LIMIT 1 FOR UPDATE`, [accountId],
        );
        if (!accounts[0]) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '未找到账户。');
        await connection.execute(
          `UPDATE warehouse_users
           SET password_hash = ?, password_state = 'CHANGE_REQUIRED', password_changed_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?`,
          [passwordHash, accountId],
        );
        await connection.execute(
          `UPDATE warehouse_sessions SET revoked_at = CURRENT_TIMESTAMP(3)
           WHERE user_id = ? AND revoked_at IS NULL`, [accountId],
        );
        await audit(connection, session, request, {
          eventType: 'ACCOUNT_PASSWORD_RESET', targetType: 'ACCOUNT', targetId: accountId,
          targetReference: accounts[0].login_name,
        });
        await connection.commit();
        return { id: accountId, temporaryPassword: password };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async deleteAccount(session: WarehouseSession, request: RequestAudit, accountIdValue: unknown) {
      const accountId = uuid(accountIdValue, 'accountId');
      if (accountId === session.userId) throw new ApiError(409, 'CANNOT_DELETE_CURRENT_ACCOUNT', '不能删除当前登录账户。');
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [accounts] = await connection.execute<(RowDataPacket & { login_name: string })[]>(
          `SELECT login_name FROM warehouse_users WHERE id = ? LIMIT 1 FOR UPDATE`, [accountId],
        );
        if (!accounts[0]) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '未找到账户。');
        const actorReference = anonymizedActor(accountId);
        await connection.execute(
          `UPDATE print_attempts SET actor_reference = ?, user_id = NULL WHERE user_id = ?`,
          [actorReference, accountId],
        );
        await connection.execute(
          `UPDATE warehouse_work_batch_print_attempts SET actor_reference = ?, user_id = NULL WHERE user_id = ?`,
          [actorReference, accountId],
        );
        await connection.execute(
          `UPDATE warehouse_work_batches SET created_by_reference = ?, created_by_user_id = NULL WHERE created_by_user_id = ?`,
          [actorReference, accountId],
        );
        await connection.execute(
          `UPDATE warehouse_work_batch_assets SET uploaded_by_reference = ?, uploaded_by_user_id = NULL WHERE uploaded_by_user_id = ?`,
          [actorReference, accountId],
        );
        await connection.execute(
          `UPDATE warehouse_work_batch_items SET claimed_by_user_id = NULL WHERE claimed_by_user_id = ?`,
          [accountId],
        );
        await connection.execute(
          `UPDATE global_intercepts
           SET created_by_reference = ?, created_by_user_id = NULL
           WHERE created_by_user_id = ?`,
          [actorReference, accountId],
        );
        await connection.execute(
          `UPDATE global_intercepts
           SET updated_by_reference = ?, updated_by_user_id = NULL
           WHERE updated_by_user_id = ?`,
          [actorReference, accountId],
        );
        await connection.execute(
          `UPDATE warehouse_security_audit_events
           SET actor_reference = ?, actor_user_id = NULL
           WHERE actor_user_id = ?`,
          [actorReference, accountId],
        );
        await connection.execute(
          `UPDATE warehouse_security_audit_events
           SET target_reference = ?, target_id = NULL
           WHERE target_type = 'ACCOUNT' AND target_id = ?`,
          [actorReference, accountId],
        );
        await connection.execute(
          `UPDATE attendance_punch_attempts
           SET evidence_delete_after = CURRENT_TIMESTAMP(3)
           WHERE user_id = ? AND evidence_delete_after > CURRENT_TIMESTAMP(3)`,
          [accountId],
        );
        await connection.execute(`DELETE FROM warehouse_sessions WHERE user_id = ?`, [accountId]);
        await connection.execute(`DELETE FROM warehouse_memberships WHERE user_id = ?`, [accountId]);
        await connection.execute(`DELETE FROM warehouse_users WHERE id = ?`, [accountId]);
        await audit(connection, session, request, {
          eventType: 'ACCOUNT_DELETED', targetType: 'ACCOUNT', targetId: null,
          targetReference: actorReference, reason: 'Permanent employee account deletion',
        });
        await connection.commit();
        return { deleted: true };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async listPermissions() {
      const [rows] = await mysql.execute<PermissionRow[]>(
        `SELECT permission_code, module_code, display_name, risk_level
         FROM warehouse_permissions ORDER BY module_code, permission_code`,
      );
      return rows.map(row => ({
        code: row.permission_code,
        module: row.module_code,
        name: row.display_name,
        riskLevel: row.risk_level,
      }));
    },

    async listRoles() {
      const [rows] = await mysql.execute<RoleRow[]>(
        `SELECT r.id, r.role_code, r.role_name, r.role_description, r.role_kind, r.role_version,
                COUNT(DISTINCT m.user_id) AS employee_count,
                GROUP_CONCAT(rp.permission_code ORDER BY rp.permission_code SEPARATOR ',') AS permissions,
                r.created_at, r.updated_at
         FROM warehouse_roles r
         LEFT JOIN warehouse_memberships m ON m.role_id = r.id
         LEFT JOIN warehouse_role_permissions rp ON rp.role_id = r.id
         GROUP BY r.id
         ORDER BY r.role_kind, r.role_name`,
      );
      return rows.map(row => ({
        id: row.id,
        code: row.role_code,
        name: row.role_name,
        description: row.role_description,
        kind: row.role_kind,
        version: Number(row.role_version),
        employeeCount: Number(row.employee_count),
        permissions: row.permissions ? row.permissions.split(',') : [],
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async createRole(session: WarehouseSession, request: RequestAudit, input: Record<string, unknown>) {
      const name = text(input.name, 'name', 20)!;
      const description = text(input.description, 'description', 512, false);
      const id = randomUUID();
      const code = `role_${id.replaceAll('-', '').slice(0, 16)}`;
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `INSERT INTO warehouse_roles
             (id, role_code, role_name, role_description, role_kind, created_by_user_id)
           VALUES (?, ?, ?, ?, 'CUSTOM', ?)`,
          [id, code, name, description, session.userId],
        );
        await audit(connection, session, request, {
          eventType: 'ROLE_CREATED', targetType: 'ROLE', targetId: id,
          targetReference: name, changeData: { description },
        });
        await connection.commit();
        return { id, code, name, description, permissions: [] };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async updateRole(session: WarehouseSession, request: RequestAudit, roleIdValue: unknown, input: Record<string, unknown>) {
      const roleId = uuid(roleIdValue, 'roleId');
      const expectedVersion = Number(input.expectedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'expectedVersion 必须是正整数。');
      }
      const name = input.name === undefined ? null : text(input.name, 'name', 20);
      const description = input.description === undefined ? undefined : text(input.description, 'description', 512, false);
      const permissionValues = input.permissions;
      if (name === null && description === undefined && permissionValues === undefined) {
        throw new ApiError(400, 'VALIDATION_ERROR', '没有可更新的角色字段。');
      }
      let permissions: WarehousePermission[] | null = null;
      if (permissionValues !== undefined) {
        if (!Array.isArray(permissionValues) || permissionValues.some(value => typeof value !== 'string')) {
          throw new ApiError(400, 'VALIDATION_ERROR', 'permissions 必须是权限代码数组。');
        }
        permissions = [...new Set(permissionValues)] as WarehousePermission[];
        const known = new Set<string>(WAREHOUSE_PERMISSION_CODES);
        if (permissions.some(value => !known.has(value))) throw new ApiError(400, 'UNKNOWN_PERMISSION', '包含未知权限代码。');
      }
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [roles] = await connection.execute<(RowDataPacket & { role_name: string; role_version: number })[]>(
          `SELECT role_name, role_version FROM warehouse_roles WHERE id = ? LIMIT 1 FOR UPDATE`, [roleId],
        );
        if (!roles[0]) throw new ApiError(404, 'ROLE_NOT_FOUND', '未找到角色。');
        if (roles[0].role_version !== expectedVersion) {
          throw new ApiError(409, 'ROLE_VERSION_CONFLICT', '角色已被其他管理员修改，请刷新后重试。');
        }
        const [updateResult] = await connection.execute<ResultSetHeader>(
          `UPDATE warehouse_roles
           SET role_name = COALESCE(?, role_name),
               role_description = CASE WHEN ? THEN ? ELSE role_description END,
               role_version = role_version + 1
           WHERE id = ? AND role_version = ?`,
          [name, description !== undefined, description ?? null, roleId, expectedVersion],
        );
        if (updateResult.affectedRows !== 1) throw new ApiError(409, 'ROLE_VERSION_CONFLICT', '角色已被其他管理员修改，请刷新后重试。');
        if (permissions) {
          await connection.execute(`DELETE FROM warehouse_role_permissions WHERE role_id = ?`, [roleId]);
          for (const permission of permissions) {
            await connection.execute(
              `INSERT INTO warehouse_role_permissions (role_id, permission_code) VALUES (?, ?)`,
              [roleId, permission],
            );
          }
        }
        await audit(connection, session, request, {
          eventType: 'ROLE_UPDATED', targetType: 'ROLE', targetId: roleId,
          targetReference: name ?? roles[0].role_name, changeData: { name, description, permissions, expectedVersion },
        });
        await connection.commit();
        return { id: roleId };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async deleteRole(session: WarehouseSession, request: RequestAudit, roleIdValue: unknown) {
      const roleId = uuid(roleIdValue, 'roleId');
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [roles] = await connection.execute<(RowDataPacket & { role_name: string })[]>(
          `SELECT role_name FROM warehouse_roles WHERE id = ? LIMIT 1 FOR UPDATE`, [roleId],
        );
        if (!roles[0]) throw new ApiError(404, 'ROLE_NOT_FOUND', '未找到角色。');
        const [permissionRows] = await connection.execute<(RowDataPacket & { permission_code: string })[]>(
          `SELECT permission_code FROM warehouse_role_permissions WHERE role_id = ? ORDER BY permission_code`,
          [roleId],
        );
        const [memberRows] = await connection.execute<(RowDataPacket & { employee_count: number })[]>(
          `SELECT COUNT(*) AS employee_count FROM warehouse_memberships WHERE role_id = ?`,
          [roleId],
        );
        await connection.execute(
          `UPDATE warehouse_sessions s
           INNER JOIN warehouse_memberships m ON m.id = s.membership_id
           SET s.revoked_at = CURRENT_TIMESTAMP(3)
           WHERE m.role_id = ? AND s.revoked_at IS NULL`,
          [roleId],
        );
        await connection.execute(`DELETE FROM warehouse_roles WHERE id = ?`, [roleId]);
        await audit(connection, session, request, {
          eventType: 'ROLE_DELETED', targetType: 'ROLE', targetId: null,
          targetReference: roles[0].role_name,
          changeData: {
            employeeCount: Number(memberRows[0]?.employee_count ?? 0),
            permissions: permissionRows.map(row => row.permission_code),
          },
        });
        await connection.commit();
        return { deleted: true };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async listSecurityAudit(input: { limit?: unknown }) {
      const limit = pageValue(input.limit, 100, 500);
      const [rows] = await mysql.query<AuditRow[]>(
        `SELECT id, event_type, outcome, actor_reference, target_type, target_reference,
                warehouse_id, request_id, ip_address, reason, change_data, occurred_at
         FROM warehouse_security_audit_events
         ORDER BY occurred_at DESC LIMIT ${limit}`,
      );
      return rows.map(row => ({
        id: row.id,
        eventType: row.event_type,
        outcome: row.outcome,
        actorReference: row.actor_reference,
        targetType: row.target_type,
        targetReference: row.target_reference,
        warehouseId: row.warehouse_id,
        requestId: row.request_id,
        ipAddress: row.ip_address,
        reason: row.reason,
        changeData: row.change_data,
        occurredAt: row.occurred_at.toISOString(),
      }));
    },
  };
}

export type WarehouseAdministration = ReturnType<typeof createWarehouseAdministration>;
