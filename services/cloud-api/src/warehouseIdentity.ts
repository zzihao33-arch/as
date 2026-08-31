import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { Redis } from 'ioredis';
import { ApiError } from './errors.js';
import { WAREHOUSE_PERMISSION_CODES, type WarehousePermission } from './warehouseAccess.js';
import {
  createWarehouseSessionToken,
  hashWarehousePassword,
  hashWarehouseSessionToken,
  parseWarehouseSessionToken,
  verifyWarehousePassword,
} from './warehouseSecurity.js';

export type WarehousePlatformRole = 'SYSTEM_ADMIN' | null;
export type WarehousePasswordState = 'ACTIVE' | 'CHANGE_REQUIRED';

export type WarehouseWorkspace = {
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  membershipId: string | null;
  roleId: string | null;
  roleName: string | null;
};

export type WarehouseSession = {
  sessionId: string;
  userId: string;
  userName: string;
  loginName: string;
  email: string | null;
  phone: string | null;
  platformRole: WarehousePlatformRole;
  passwordState: WarehousePasswordState;
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  membershipId: string | null;
  roleId: string | null;
  roleName: string | null;
  permissions: WarehousePermission[];
  workspaces: WarehouseWorkspace[];
  expiresAt: string;
  absoluteExpiresAt: string;
};

type UserLoginRow = RowDataPacket & {
  id: string;
  login_name: string;
  email: string | null;
  phone: string | null;
  display_name: string;
  password_hash: string;
  password_state: WarehousePasswordState;
  platform_role: WarehousePlatformRole;
  user_status: 'ACTIVE' | 'DISABLED';
};

type SessionRow = RowDataPacket & {
  sessionId: string;
  token_hash: Buffer;
  userId: string;
  userName: string;
  loginName: string;
  email: string | null;
  phone: string | null;
  platformRole: WarehousePlatformRole;
  passwordState: WarehousePasswordState;
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  selectedMembershipId: string | null;
  membershipId: string | null;
  roleId: string | null;
  roleName: string | null;
  expiresAt: Date;
  absoluteExpiresAt: Date;
};

type WorkspaceRow = RowDataPacket & {
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  membershipId: string | null;
  roleId: string | null;
  roleName: string | null;
};

type PermissionRow = RowDataPacket & { permission_code: WarehousePermission };
type WorkstationRow = RowDataPacket & { id: string; installation_id: string; display_name: string };
type IdentityRequestAudit = { requestId: string; ip: string; userAgent?: string };

const DUMMY_PASSWORD_HASH = `scrypt$32768$8$1$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(32).toString('base64url')}`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是字符串。`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 长度无效。`);
  return normalized;
}

function loginNameValue(value: unknown): string {
  const loginName = safeText(value, 'loginName', 50).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,49}$/.test(loginName)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '账号需为 3–50 位字母、数字、点、下划线或连字符。');
  }
  return loginName;
}

function passwordValue(value: unknown, field = 'password'): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} 长度无效。`);
  }
  return value;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function loginRateLimitKey(loginName: string): string {
  return `cmhub:warehouse-login:${hashWarehouseSessionToken(loginName).toString('hex').slice(0, 32)}`;
}

async function checkLoginRateLimit(redis: Redis, loginName: string): Promise<void> {
  try {
    const failures = Number(await redis.get(loginRateLimitKey(loginName)) ?? 0);
    if (failures >= 5) throw new ApiError(429, 'LOGIN_LOCKED', '登录失败次数过多，请 30 分钟后重试或联系管理员解锁。');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'AUTH_SERVICE_UNAVAILABLE', '登录服务暂时不可用。');
  }
}

async function recordLoginFailure(redis: Redis, loginName: string): Promise<void> {
  try {
    const key = loginRateLimitKey(loginName);
    const failures = await redis.incr(key);
    if (failures === 1) await redis.expire(key, 30 * 60);
  } catch {
    throw new ApiError(503, 'AUTH_SERVICE_UNAVAILABLE', '登录服务暂时不可用。');
  }
}

export function createWarehouseIdentity(dependencies: {
  mysql: Pool;
  redis: Redis;
  sessionLifetimeHours: number;
  absoluteSessionLifetimeHours?: number;
}) {
  const { mysql, redis, sessionLifetimeHours } = dependencies;
  const absoluteSessionLifetimeHours = dependencies.absoluteSessionLifetimeHours ?? 16;

  async function auditIdentity(
    executor: Pool | PoolConnection,
    request: IdentityRequestAudit,
    input: {
      eventType: string;
      outcome: 'SUCCESS' | 'DENIED' | 'FAILED';
      actorUserId?: string | null;
      actorReference: string;
      targetId?: string | null;
      targetReference: string;
      warehouseId?: string | null;
      reason?: string;
    },
  ): Promise<void> {
    await executor.execute(
      `INSERT INTO warehouse_security_audit_events
         (id, event_type, outcome, actor_user_id, actor_reference, target_type, target_id,
          target_reference, warehouse_id, request_id, ip_address, user_agent, reason)
       VALUES (?, ?, ?, ?, ?, 'ACCOUNT', ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), input.eventType, input.outcome, input.actorUserId ?? null, input.actorReference,
        input.targetId ?? null, input.targetReference, input.warehouseId ?? null, request.requestId,
        request.ip.slice(0, 64), request.userAgent?.slice(0, 512) ?? null, input.reason ?? null],
    );
  }

  async function listWorkspaces(userId: string, platformRole: WarehousePlatformRole): Promise<WarehouseWorkspace[]> {
    const [rows] = platformRole === 'SYSTEM_ADMIN'
      ? await mysql.execute<WorkspaceRow[]>(
        `SELECT w.id AS warehouseId, w.warehouse_code AS warehouseCode, w.display_name AS warehouseName,
                m.id AS membershipId, r.id AS roleId, r.role_name AS roleName
         FROM warehouses w
         LEFT JOIN warehouse_memberships m ON m.warehouse_id = w.id AND m.user_id = ? AND m.membership_status = 'ACTIVE'
         LEFT JOIN warehouse_roles r ON r.id = m.role_id
         WHERE w.warehouse_status = 'ACTIVE'
         ORDER BY w.display_name, w.warehouse_code`,
        [userId],
      )
      : await mysql.execute<WorkspaceRow[]>(
        `SELECT w.id AS warehouseId, w.warehouse_code AS warehouseCode, w.display_name AS warehouseName,
                m.id AS membershipId, r.id AS roleId, r.role_name AS roleName
         FROM warehouse_memberships m
         INNER JOIN warehouses w ON w.id = m.warehouse_id AND w.warehouse_status = 'ACTIVE'
         INNER JOIN warehouse_roles r ON r.id = m.role_id
         WHERE m.user_id = ? AND m.membership_status = 'ACTIVE'
         ORDER BY w.display_name, w.warehouse_code`,
        [userId],
      );
    return rows.map(row => ({ ...row }));
  }

  async function listPermissions(platformRole: WarehousePlatformRole, roleId: string | null): Promise<WarehousePermission[]> {
    if (platformRole === 'SYSTEM_ADMIN') return [...WAREHOUSE_PERMISSION_CODES];
    if (!roleId) return [];
    const [rows] = await mysql.execute<PermissionRow[]>(
      `SELECT permission_code FROM warehouse_role_permissions WHERE role_id = ? ORDER BY permission_code`,
      [roleId],
    );
    return rows.map(row => row.permission_code);
  }

  async function materializeSession(row: SessionRow): Promise<WarehouseSession> {
    if (row.selectedMembershipId && !row.membershipId && row.platformRole !== 'SYSTEM_ADMIN') {
      throw new ApiError(401, 'SESSION_INVALID', '当前仓库成员身份已失效，请重新登录。');
    }
    const [permissions, workspaces] = await Promise.all([
      listPermissions(row.platformRole, row.roleId),
      listWorkspaces(row.userId, row.platformRole),
    ]);
    return {
      sessionId: row.sessionId,
      userId: row.userId,
      userName: row.userName,
      loginName: row.loginName,
      email: row.email,
      phone: row.phone,
      platformRole: row.platformRole,
      passwordState: row.passwordState,
      warehouseId: row.warehouseId,
      warehouseCode: row.warehouseCode,
      warehouseName: row.warehouseName,
      membershipId: row.membershipId,
      roleId: row.roleId,
      roleName: row.roleName,
      permissions,
      workspaces,
      expiresAt: iso(row.expiresAt),
      absoluteExpiresAt: iso(row.absoluteExpiresAt),
    };
  }

  async function authenticate(token: string | null): Promise<WarehouseSession> {
    const parsed = token ? parseWarehouseSessionToken(token) : null;
    if (!token || !parsed) throw new ApiError(401, 'SESSION_REQUIRED', '请先登录仓库工作台。');
    const [rows] = await mysql.execute<SessionRow[]>(
      `SELECT s.id AS sessionId, s.token_hash,
              u.id AS userId, u.display_name AS userName, u.login_name AS loginName,
              u.email, u.phone, u.platform_role AS platformRole, u.password_state AS passwordState,
              w.id AS warehouseId, w.warehouse_code AS warehouseCode, w.display_name AS warehouseName,
              s.membership_id AS selectedMembershipId, m.id AS membershipId,
              r.id AS roleId, r.role_name AS roleName,
              s.expires_at AS expiresAt, s.absolute_expires_at AS absoluteExpiresAt
       FROM warehouse_sessions s
       INNER JOIN warehouse_users u ON u.id = s.user_id AND u.user_status = 'ACTIVE'
       LEFT JOIN warehouses w ON w.id = s.warehouse_id AND w.warehouse_status = 'ACTIVE'
       LEFT JOIN warehouse_memberships m ON m.id = s.membership_id
         AND m.user_id = u.id AND m.warehouse_id = w.id AND m.membership_status = 'ACTIVE'
       LEFT JOIN warehouse_roles r ON r.id = m.role_id
       WHERE s.session_key_id = ? AND s.revoked_at IS NULL
         AND s.expires_at > CURRENT_TIMESTAMP(3) AND s.absolute_expires_at > CURRENT_TIMESTAMP(3)
       LIMIT 1`,
      [parsed.keyId],
    );
    const row = rows[0];
    const suppliedHash = hashWarehouseSessionToken(token);
    if (!row || row.token_hash.length !== suppliedHash.length || !timingSafeEqual(row.token_hash, suppliedHash)) {
      throw new ApiError(401, 'SESSION_INVALID', '登录会话已失效，请重新登录。');
    }
    await mysql.execute(
      `UPDATE warehouse_sessions SET last_seen_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND last_seen_at < CURRENT_TIMESTAMP(3) - INTERVAL 5 MINUTE`,
      [row.sessionId],
    );
    return materializeSession(row);
  }

  return {
    async login(input: { loginName: unknown; password: unknown; requestId: string; ip: string; userAgent?: string }) {
      const loginName = loginNameValue(input.loginName);
      const password = passwordValue(input.password);
      try {
        await checkLoginRateLimit(redis, loginName);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'LOGIN_LOCKED') {
          await auditIdentity(mysql, input, {
            eventType: 'LOGIN_DENIED', outcome: 'DENIED', actorReference: `login:${loginName}`,
            targetReference: loginName, reason: 'Account temporarily locked after repeated failures',
          });
        }
        throw error;
      }
      const [rows] = await mysql.execute<UserLoginRow[]>(
        `SELECT id, login_name, email, phone, display_name, password_hash, password_state, platform_role, user_status
         FROM warehouse_users WHERE login_name = ? LIMIT 1`,
        [loginName],
      );
      const user = rows[0];
      const passwordMatches = await verifyWarehousePassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
      if (!user || !passwordMatches) {
        let rateLimitError: unknown;
        try {
          await recordLoginFailure(redis, loginName);
        } catch (error) {
          rateLimitError = error;
        }
        await auditIdentity(mysql, input, {
          eventType: 'LOGIN_DENIED', outcome: 'DENIED', actorUserId: user?.id,
          actorReference: user ? `user:${user.id}` : `login:${loginName}`,
          targetId: user?.id, targetReference: loginName, reason: 'Invalid credentials',
        });
        if (rateLimitError) throw rateLimitError;
        throw new ApiError(401, 'INVALID_CREDENTIALS', '账号或密码错误。');
      }
      if (user.user_status !== 'ACTIVE') {
        await auditIdentity(mysql, input, {
          eventType: 'LOGIN_DENIED', outcome: 'DENIED', actorUserId: user.id,
          actorReference: `user:${user.id}`, targetId: user.id, targetReference: loginName,
          reason: 'Account disabled',
        });
        throw new ApiError(403, 'ACCOUNT_UNAVAILABLE', '账户异常，请联系管理员。');
      }
      await redis.del(loginRateLimitKey(loginName)).catch(() => undefined);

      const workspaces = await listWorkspaces(user.id, user.platform_role);
      if (user.platform_role !== 'SYSTEM_ADMIN' && workspaces.length === 0) {
        await auditIdentity(mysql, input, {
          eventType: 'LOGIN_DENIED', outcome: 'DENIED', actorUserId: user.id,
          actorReference: `user:${user.id}`, targetId: user.id, targetReference: loginName,
          reason: 'No active role assignment',
        });
        throw new ApiError(403, 'ACCOUNT_UNAVAILABLE', '账户异常，请联系管理员。');
      }
      const selected = workspaces.length === 1 ? workspaces[0] : null;
      const issued = createWarehouseSessionToken();
      const sessionId = randomUUID();
      await mysql.execute(
        `INSERT INTO warehouse_sessions
           (id, session_key_id, token_hash, user_id, warehouse_id, membership_id,
            expires_at, absolute_expires_at, created_ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?,
                 DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR),
                 DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR), ?, ?)`,
        [sessionId, issued.keyId, issued.tokenHash, user.id, selected?.warehouseId ?? null,
          selected?.membershipId ?? null, sessionLifetimeHours, absoluteSessionLifetimeHours,
          input.ip.slice(0, 64), input.userAgent?.slice(0, 512) ?? null],
      );
      await mysql.execute(`UPDATE warehouse_users SET last_login_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, [user.id]);
      await auditIdentity(mysql, input, {
        eventType: 'LOGIN_SUCCEEDED', outcome: 'SUCCESS', actorUserId: user.id,
        actorReference: `user:${user.id}`, targetId: user.id, targetReference: loginName,
        warehouseId: selected?.warehouseId,
      });
      return { token: issued.token, session: await authenticate(issued.token) };
    },

    authenticate,

    async renew(session: WarehouseSession, request: IdentityRequestAudit) {
      if (session.passwordState === 'CHANGE_REQUIRED') {
        throw new ApiError(409, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码。');
      }
      const issued = createWarehouseSessionToken();
      const [result] = await mysql.execute<ResultSetHeader>(
        `UPDATE warehouse_sessions
         SET session_key_id = ?, token_hash = ?,
             expires_at = LEAST(DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR), absolute_expires_at),
             last_seen_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND revoked_at IS NULL AND absolute_expires_at > CURRENT_TIMESTAMP(3)`,
        [issued.keyId, issued.tokenHash, sessionLifetimeHours, session.sessionId],
      );
      if (result.affectedRows !== 1) throw new ApiError(401, 'SESSION_INVALID', '登录会话已失效，请重新登录。');
      await auditIdentity(mysql, request, {
        eventType: 'SESSION_RENEWED', outcome: 'SUCCESS', actorUserId: session.userId,
        actorReference: `user:${session.userId}`, targetId: session.userId,
        targetReference: session.loginName, warehouseId: session.warehouseId,
      });
      return { token: issued.token, session: await authenticate(issued.token) };
    },

    async selectWorkspace(session: WarehouseSession, warehouseIdValue: unknown, request: IdentityRequestAudit) {
      const warehouseId = safeText(warehouseIdValue, 'warehouseId', 36);
      if (!UUID_PATTERN.test(warehouseId)) throw new ApiError(400, 'VALIDATION_ERROR', 'warehouseId 必须是 UUID。');
      const workspaces = await listWorkspaces(session.userId, session.platformRole);
      const workspace = workspaces.find(item => item.warehouseId === warehouseId);
      if (!workspace) throw new ApiError(403, 'WAREHOUSE_NOT_ALLOWED', '当前账号无权进入该仓库。');
      await mysql.execute(
        `UPDATE warehouse_sessions SET warehouse_id = ?, membership_id = ?, last_seen_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
        [workspace.warehouseId, workspace.membershipId, session.sessionId, session.userId],
      );
      await auditIdentity(mysql, request, {
        eventType: 'WORKSPACE_SELECTED', outcome: 'SUCCESS', actorUserId: session.userId,
        actorReference: `user:${session.userId}`, targetId: session.userId,
        targetReference: session.loginName, warehouseId: workspace.warehouseId,
      });
      return { ...session, ...workspace, permissions: await listPermissions(session.platformRole, workspace.roleId) };
    },

    async changePassword(
      session: WarehouseSession,
      input: { currentPassword: unknown; newPassword: unknown },
      request: IdentityRequestAudit,
    ) {
      const currentPassword = passwordValue(input.currentPassword, 'currentPassword');
      const newPassword = passwordValue(input.newPassword, 'newPassword');
      if (newPassword.length < 16) throw new ApiError(400, 'WEAK_PASSWORD', '新密码至少需要 16 个字符。');
      const [rows] = await mysql.execute<(RowDataPacket & { password_hash: string })[]>(
        `SELECT password_hash FROM warehouse_users WHERE id = ? AND user_status = 'ACTIVE' LIMIT 1`,
        [session.userId],
      );
      if (!rows[0] || !await verifyWarehousePassword(currentPassword, rows[0].password_hash)) {
        throw new ApiError(401, 'INVALID_CURRENT_PASSWORD', '当前密码不正确。');
      }
      const passwordHash = await hashWarehousePassword(newPassword);
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `UPDATE warehouse_users
           SET password_hash = ?, password_state = 'ACTIVE', password_changed_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?`,
          [passwordHash, session.userId],
        );
        await connection.execute(
          `UPDATE warehouse_sessions SET revoked_at = CURRENT_TIMESTAMP(3)
           WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`,
          [session.userId, session.sessionId],
        );
        await auditIdentity(connection, request, {
          eventType: 'PASSWORD_CHANGED', outcome: 'SUCCESS', actorUserId: session.userId,
          actorReference: `user:${session.userId}`, targetId: session.userId,
          targetReference: session.loginName, warehouseId: session.warehouseId,
        });
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async logout(session: WarehouseSession, request: IdentityRequestAudit): Promise<void> {
      await auditIdentity(mysql, request, {
        eventType: 'LOGOUT', outcome: 'SUCCESS', actorUserId: session.userId,
        actorReference: `user:${session.userId}`, targetId: session.userId,
        targetReference: session.loginName, warehouseId: session.warehouseId,
      });
      await mysql.execute(
        `UPDATE warehouse_sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL`,
        [session.sessionId],
      );
    },

    async unlockLogin(
      loginNameInput: unknown,
      session: WarehouseSession,
      request: IdentityRequestAudit,
    ): Promise<void> {
      const targetLoginName = loginNameValue(loginNameInput);
      await redis.del(loginRateLimitKey(targetLoginName));
      await auditIdentity(mysql, request, {
        eventType: 'LOGIN_LOCK_CLEARED', outcome: 'SUCCESS', actorUserId: session.userId,
        actorReference: `user:${session.userId}`, targetReference: targetLoginName,
        warehouseId: session.warehouseId,
      });
    },

    async registerWorkstation(session: WarehouseSession, input: { installationId: unknown; displayName: unknown }) {
      if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择要进入的仓库。');
      const installationId = safeText(input.installationId, 'installationId', 64);
      if (!/^[a-zA-Z0-9_-]{16,64}$/.test(installationId)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'installationId 格式无效。');
      }
      const displayName = safeText(input.displayName, 'displayName', 128);
      const proposedId = randomUUID();
      await mysql.execute(
        `INSERT INTO workstations (id, warehouse_id, installation_id, display_name)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), last_seen_at = CURRENT_TIMESTAMP(3)`,
        [proposedId, session.warehouseId, installationId, displayName],
      );
      const [rows] = await mysql.execute<WorkstationRow[]>(
        `SELECT id, installation_id, display_name FROM workstations
         WHERE warehouse_id = ? AND installation_id = ? AND workstation_status = 'ACTIVE' LIMIT 1`,
        [session.warehouseId, installationId],
      );
      if (!rows[0]) throw new ApiError(403, 'WORKSTATION_DISABLED', '此工作站已被停用。');
      return { id: rows[0].id, installationId: rows[0].installation_id, displayName: rows[0].display_name };
    },
  };
}

export type WarehouseIdentity = ReturnType<typeof createWarehouseIdentity>;
