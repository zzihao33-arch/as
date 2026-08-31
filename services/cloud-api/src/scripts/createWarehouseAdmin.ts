import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import { closeConnections, mysql } from '../db.js';
import { hashWarehousePassword, normalizeWarehouseEmail } from '../warehouseSecurity.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1]?.trim();
}

async function main(): Promise<void> {
  const warehouseCode = option('--warehouse-code')?.toLowerCase();
  const warehouseName = option('--warehouse-name');
  const loginName = option('--login-name')?.toLowerCase();
  const emailOption = option('--email');
  const email = emailOption ? normalizeWarehouseEmail(emailOption) : null;
  const displayName = option('--display-name');
  const password = process.env.CMHUB_BOOTSTRAP_PASSWORD ?? '';
  if (!warehouseCode || !/^[a-z0-9_-]{2,64}$/.test(warehouseCode) || !warehouseName || warehouseName.length > 128
      || !loginName || !/^[a-z0-9][a-z0-9._-]{2,49}$/.test(loginName)) {
    throw new Error('Usage: CMHUB_BOOTSTRAP_PASSWORD=<secret> npm run create-warehouse-admin -- --warehouse-code <code> --warehouse-name <name> --login-name <login> [--email <email>] --display-name <name>');
  }
  if ((email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || !displayName || displayName.length > 128) {
    throw new Error('A valid optional --email and required --display-name are required.');
  }
  if (password.length < 16 || password.length > 256) {
    throw new Error('CMHUB_BOOTSTRAP_PASSWORD must contain 16 to 256 characters. It is intentionally not accepted as a command-line argument.');
  }
  const passwordHash = await hashWarehousePassword(password);
  const connection = await mysql.getConnection();
  try {
    await connection.beginTransaction();
    const [warehouseRows] = await connection.execute<(RowDataPacket & { id: string })[]>(
      `SELECT id FROM warehouses WHERE warehouse_code = ? LIMIT 1 FOR UPDATE`, [warehouseCode],
    );
    const warehouseId = warehouseRows[0]?.id ?? randomUUID();
    if (!warehouseRows[0]) {
      await connection.execute(
        `INSERT INTO warehouses (id, warehouse_code, display_name) VALUES (?, ?, ?)`,
        [warehouseId, warehouseCode, warehouseName],
      );
    }
    const [existingUsers] = await connection.execute<(RowDataPacket & { id: string })[]>(
      `SELECT id FROM warehouse_users WHERE login_name = ? LIMIT 1 FOR UPDATE`, [loginName],
    );
    if (existingUsers[0]) throw new Error('This login name already exists. Use account management instead of resetting a password through bootstrap.');
    const userId = randomUUID();
    await connection.execute(
      `INSERT INTO warehouse_users
         (id, login_name, email, display_name, password_hash, platform_role, password_state, password_changed_at)
       VALUES (?, ?, ?, ?, ?, 'SYSTEM_ADMIN', 'ACTIVE', CURRENT_TIMESTAMP(3))`,
      [userId, loginName, email, displayName, passwordHash],
    );
    await connection.execute(
      `INSERT INTO warehouse_memberships (id, warehouse_id, user_id, role, role_id)
       VALUES (?, ?, ?, 'ADMIN', '00000000-0000-4000-8000-000000000102')`,
      [randomUUID(), warehouseId, userId],
    );
    await connection.commit();
    console.log(`System administrator created: ${loginName}`);
    console.log(`Warehouse: ${warehouseCode} (${warehouseName})`);
    console.log('Shipment visibility: all upstream clients');
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
