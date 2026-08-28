import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import type { Redis } from 'ioredis';
import { ApiError } from './errors.js';
import {
  createWarehouseSessionToken,
  hashWarehousePassword,
  hashWarehouseSessionToken,
  normalizeWarehouseEmail,
  parseWarehouseSessionToken,
  verifyWarehousePassword,
} from './warehouseSecurity.js';

export type WarehouseRole = 'OPERATOR' | 'SUPERVISOR' | 'ADMIN';
export type WarehouseSession = {
  sessionId: string;
  userId: string;
  userName: string;
  email: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  membershipId: string;
  role: WarehouseRole;
};

type LoginRow = RowDataPacket & Omit<WarehouseSession, 'sessionId'> & { password_hash: string };
type SessionRow = RowDataPacket & WarehouseSession & { token_hash: Buffer };
type WorkstationRow = RowDataPacket & { id: string; installation_id: string; display_name: string };
type MemberRow = RowDataPacket & {
  user_id: string;
  email: string;
  display_name: string;
  role: WarehouseRole;
  membership_status: 'ACTIVE' | 'DISABLED';
  last_login_at: Date | null;
  created_at: Date;
};

const DUMMY_PASSWORD_HASH = `scrypt$32768$8$1$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(32).toString('base64url')}`;

function safeText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是字符串。`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 长度无效。`);
  return normalized;
}

function warehouseRole(value: unknown): WarehouseRole {
  const role = safeText(value, 'role', 32) as WarehouseRole;
  if (!['OPERATOR', 'SUPERVISOR', 'ADMIN'].includes(role)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'role 不受支持。');
  }
  return role;
}

async function enforceLoginRateLimit(redis: Redis, ip: string, email: string): Promise<void> {
  const bucket = Math.floor(Date.now() / (10 * 60_000));
  const digest = hashWarehouseSessionToken(`${ip}:${email}`).toString('hex').slice(0, 24);
  const key = `cmhub:warehouse-login:${digest}:${bucket}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 10 * 60);
    if (count > 10) throw new ApiError(429, 'LOGIN_RATE_LIMITED', '登录尝试过于频繁，请稍后重试。');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'AUTH_SERVICE_UNAVAILABLE', '登录服务暂时不可用。');
  }
}

export function createWarehouseIdentity(dependencies: {
  mysql: Pool;
  redis: Redis;
  sessionLifetimeHours: number;
}) {
  const { mysql, redis, sessionLifetimeHours } = dependencies;

  return {
    async login(input: { email: unknown; password: unknown; warehouseCode: unknown; ip: string; userAgent?: string }) {
      const email = normalizeWarehouseEmail(safeText(input.email, 'email', 254));
      const password = safeText(input.password, 'password', 256);
      const warehouseCode = safeText(input.warehouseCode, 'warehouseCode', 64).toLowerCase();
      await enforceLoginRateLimit(redis, input.ip, email);

      const [rows] = await mysql.execute<LoginRow[]>(
        `SELECT u.id AS userId, u.display_name AS userName, u.email,
                w.id AS warehouseId, w.warehouse_code AS warehouseCode, w.display_name AS warehouseName,
                m.id AS membershipId, m.role, u.password_hash
         FROM warehouse_users u
         INNER JOIN warehouse_memberships m ON m.user_id = u.id AND m.membership_status = 'ACTIVE'
         INNER JOIN warehouses w ON w.id = m.warehouse_id AND w.warehouse_status = 'ACTIVE'
         WHERE u.email = ? AND u.user_status = 'ACTIVE' AND w.warehouse_code = ?
         LIMIT 1`,
        [email, warehouseCode],
      );
      const row = rows[0];
      const passwordMatches = await verifyWarehousePassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
      if (!row || !passwordMatches) throw new ApiError(401, 'INVALID_CREDENTIALS', '邮箱、密码或仓库代码不正确。');

      const session = createWarehouseSessionToken();
      const sessionId = randomUUID();
      await mysql.execute(
        `INSERT INTO warehouse_sessions
           (id, session_key_id, token_hash, user_id, warehouse_id, membership_id, expires_at, created_ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR), ?, ?)`,
        [sessionId, session.keyId, session.tokenHash, row.userId, row.warehouseId, row.membershipId,
          sessionLifetimeHours, input.ip.slice(0, 64), input.userAgent?.slice(0, 512) ?? null],
      );
      await mysql.execute(`UPDATE warehouse_users SET last_login_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, [row.userId]);
      return {
        token: session.token,
        session: {
          sessionId,
          userId: row.userId,
          userName: row.userName,
          email: row.email,
          warehouseId: row.warehouseId,
          warehouseCode: row.warehouseCode,
          warehouseName: row.warehouseName,
          membershipId: row.membershipId,
          role: row.role,
        } satisfies WarehouseSession,
      };
    },

    async authenticate(token: string | null): Promise<WarehouseSession> {
      const parsed = token ? parseWarehouseSessionToken(token) : null;
      if (!token || !parsed) throw new ApiError(401, 'SESSION_REQUIRED', '请先登录仓库工作台。');
      const [rows] = await mysql.execute<SessionRow[]>(
        `SELECT s.id AS sessionId, s.token_hash, u.id AS userId, u.display_name AS userName, u.email,
                w.id AS warehouseId, w.warehouse_code AS warehouseCode, w.display_name AS warehouseName,
                m.id AS membershipId, m.role
         FROM warehouse_sessions s
         INNER JOIN warehouse_users u ON u.id = s.user_id AND u.user_status = 'ACTIVE'
         INNER JOIN warehouses w ON w.id = s.warehouse_id AND w.warehouse_status = 'ACTIVE'
         INNER JOIN warehouse_memberships m ON m.id = s.membership_id
           AND m.user_id = u.id AND m.warehouse_id = w.id AND m.membership_status = 'ACTIVE'
         WHERE s.session_key_id = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP(3)
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
      const { token_hash: _tokenHash, ...session } = row;
      return session;
    },

    async logout(sessionId: string): Promise<void> {
      await mysql.execute(`UPDATE warehouse_sessions SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL`, [sessionId]);
    },

    async registerWorkstation(session: WarehouseSession, input: { installationId: unknown; displayName: unknown }) {
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

    async listMembers(session: WarehouseSession) {
      const [rows] = await mysql.execute<MemberRow[]>(
        `SELECT u.id AS user_id, u.email, u.display_name, m.role, m.membership_status, u.last_login_at, m.created_at
         FROM warehouse_memberships m
         INNER JOIN warehouse_users u ON u.id = m.user_id
         WHERE m.warehouse_id = ?
         ORDER BY m.created_at ASC`,
        [session.warehouseId],
      );
      return rows.map(row => ({
        userId: row.user_id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        status: row.membership_status,
        lastLoginAt: row.last_login_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      }));
    },

    async createMember(session: WarehouseSession, input: { email: unknown; displayName: unknown; password: unknown; role: unknown }) {
      const email = normalizeWarehouseEmail(safeText(input.email, 'email', 254));
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'VALIDATION_ERROR', 'email 格式无效。');
      const displayName = safeText(input.displayName, 'displayName', 128);
      const password = safeText(input.password, 'password', 256);
      if (password.length < 16) throw new ApiError(400, 'VALIDATION_ERROR', '初始密码至少需要 16 个字符。');
      const role = warehouseRole(input.role);
      const passwordHash = await hashWarehousePassword(password);
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [existing] = await connection.execute<(RowDataPacket & { id: string })[]>(
          `SELECT id FROM warehouse_users WHERE email = ? LIMIT 1 FOR UPDATE`, [email],
        );
        if (existing[0]) throw new ApiError(409, 'USER_ALREADY_EXISTS', '该邮箱已存在，不能由仓库管理员覆盖其密码或身份。');
        const userId = randomUUID();
        await connection.execute(
          `INSERT INTO warehouse_users (id, email, display_name, password_hash) VALUES (?, ?, ?, ?)`,
          [userId, email, displayName, passwordHash],
        );
        await connection.execute(
          `INSERT INTO warehouse_memberships (id, warehouse_id, user_id, role) VALUES (?, ?, ?, ?)`,
          [randomUUID(), session.warehouseId, userId, role],
        );
        await connection.commit();
        return { userId, email, displayName, role, status: 'ACTIVE' as const };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async updateMember(session: WarehouseSession, userIdValue: unknown, input: { role?: unknown; status?: unknown }) {
      const userId = safeText(userIdValue, 'userId', 36);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'userId 必须是 UUID。');
      }
      const nextRole = input.role === undefined ? null : warehouseRole(input.role);
      const nextStatus = input.status === undefined ? null : safeText(input.status, 'status', 16);
      if (nextStatus && !['ACTIVE', 'DISABLED'].includes(nextStatus)) throw new ApiError(400, 'VALIDATION_ERROR', 'status 不受支持。');
      if (!nextRole && !nextStatus) throw new ApiError(400, 'VALIDATION_ERROR', '至少需要提供 role 或 status。');

      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [members] = await connection.execute<(RowDataPacket & { id: string; role: WarehouseRole; membership_status: string })[]>(
          `SELECT id, role, membership_status FROM warehouse_memberships
           WHERE warehouse_id = ? AND user_id = ? LIMIT 1 FOR UPDATE`,
          [session.warehouseId, userId],
        );
        const member = members[0];
        if (!member) throw new ApiError(404, 'MEMBER_NOT_FOUND', '未找到该仓库成员。');
        const removesActiveAdmin = member.role === 'ADMIN' && member.membership_status === 'ACTIVE'
          && ((nextRole && nextRole !== 'ADMIN') || nextStatus === 'DISABLED');
        if (removesActiveAdmin) {
          const [otherAdmins] = await connection.execute<(RowDataPacket & { user_id: string })[]>(
            `SELECT user_id FROM warehouse_memberships
             WHERE warehouse_id = ? AND role = 'ADMIN' AND membership_status = 'ACTIVE' AND user_id <> ? FOR UPDATE`,
            [session.warehouseId, userId],
          );
          if (otherAdmins.length < 1) {
            throw new ApiError(409, 'LAST_ADMIN_REQUIRED', '不能停用或降级仓库的最后一个管理员。');
          }
        }
        await connection.execute(
          `UPDATE warehouse_memberships
           SET role = COALESCE(?, role), membership_status = COALESCE(?, membership_status)
           WHERE id = ?`,
          [nextRole, nextStatus, member.id],
        );
        if (nextStatus === 'DISABLED') {
          await connection.execute(
            `UPDATE warehouse_sessions SET revoked_at = CURRENT_TIMESTAMP(3)
             WHERE warehouse_id = ? AND user_id = ? AND revoked_at IS NULL`,
            [session.warehouseId, userId],
          );
        }
        await connection.commit();
        return { userId, role: nextRole ?? member.role, status: nextStatus ?? member.membership_status };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

export type WarehouseIdentity = ReturnType<typeof createWarehouseIdentity>;
