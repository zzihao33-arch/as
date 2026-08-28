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
  const email = normalizeWarehouseEmail(option('--email') ?? '');
  const displayName = option('--display-name');
  const clientCodes = [...new Set((option('--client-codes') ?? '').split(',').map(value => value.trim()).filter(Boolean))];
  const password = process.env.CMHUB_BOOTSTRAP_PASSWORD ?? '';
  if (!warehouseCode || !/^[a-z0-9_-]{2,64}$/.test(warehouseCode) || !warehouseName || warehouseName.length > 128) {
    throw new Error('Usage: CMHUB_BOOTSTRAP_PASSWORD=<secret> npm run create-warehouse-admin -- --warehouse-code <code> --warehouse-name <name> --email <email> --display-name <name> --client-codes <code,code>');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !displayName || displayName.length > 128) {
    throw new Error('A valid --email and --display-name are required.');
  }
  if (password.length < 16 || password.length > 256) {
    throw new Error('CMHUB_BOOTSTRAP_PASSWORD must contain 16 to 256 characters. It is intentionally not accepted as a command-line argument.');
  }
  if (clientCodes.length === 0) throw new Error('--client-codes must grant at least one existing upstream client.');

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
      `SELECT id FROM warehouse_users WHERE email = ? LIMIT 1 FOR UPDATE`, [email],
    );
    if (existingUsers[0]) throw new Error('This warehouse user already exists. Use a future account-management command instead of resetting a password through bootstrap.');
    const userId = randomUUID();
    await connection.execute(
      `INSERT INTO warehouse_users (id, email, display_name, password_hash) VALUES (?, ?, ?, ?)`,
      [userId, email, displayName, passwordHash],
    );
    await connection.execute(
      `INSERT INTO warehouse_memberships (id, warehouse_id, user_id, role) VALUES (?, ?, ?, 'ADMIN')`,
      [randomUUID(), warehouseId, userId],
    );
    const [clientRows] = await connection.query<(RowDataPacket & { id: string; client_code: string })[]>(
      `SELECT id, client_code FROM clients WHERE client_code IN (?) AND client_status = 'ACTIVE' FOR UPDATE`,
      [clientCodes],
    );
    const foundCodes = new Set(clientRows.map(row => row.client_code));
    const missingCodes = clientCodes.filter(code => !foundCodes.has(code));
    if (missingCodes.length > 0) throw new Error(`Unknown or disabled client codes: ${missingCodes.join(', ')}`);
    for (const client of clientRows) {
      await connection.execute(
        `INSERT INTO warehouse_client_access (id, warehouse_id, client_id) VALUES (?, ?, ?)`,
        [randomUUID(), warehouseId, client.id],
      );
    }
    await connection.commit();
    console.log(`Warehouse administrator created: ${email}`);
    console.log(`Warehouse: ${warehouseCode} (${warehouseName})`);
    console.log(`Granted clients: ${clientCodes.join(', ')}`);
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
