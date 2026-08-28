import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import { issueApiKey, parseScopeOption, type ApiKeyEnvironment } from '../apiKeys.js';
import { mysql, closeConnections } from '../db.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1]?.trim();
}

async function main(): Promise<void> {
  const code = option('--code');
  const name = option('--name');
  const environment = (option('--environment') ?? 'live') as ApiKeyEnvironment;
  const limit = Number(option('--rate-limit') ?? 600);
  const scopes = parseScopeOption(option('--scopes'));
  if (!code || !/^[a-zA-Z0-9_-]{2,64}$/.test(code)) {
    throw new Error('Usage: npm run create-client-key -- --code <client-code> [--name <display-name>] [--environment live|test] [--rate-limit 600] [--scopes shipments:write,shipments:read,labels:write]');
  }
  if ((name && name.length > 128) || !['live', 'test'].includes(environment) || !Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error('Client name, environment, or rate limit is invalid.');
  }

  const issued = issueApiKey(environment);
  const connection = await mysql.getConnection();
  let clientId: string;
  let createdClient = false;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<(RowDataPacket & { id: string })[]>(
      'SELECT id FROM clients WHERE client_code = ? LIMIT 1 FOR UPDATE',
      [code],
    );
    clientId = rows[0]?.id ?? randomUUID();
    if (!rows[0]) {
      if (!name) throw new Error('--name is required when creating a new client.');
      await connection.execute(
        `INSERT INTO clients
         (id, client_code, display_name, client_status, key_id, api_key_prefix, api_key_hash, rate_limit_per_minute)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
        [clientId, code, name, issued.keyId, issued.prefix, issued.hash, limit],
      );
      createdClient = true;
    }
    await connection.execute(
      `INSERT INTO integration_api_keys
       (id, client_id, key_id, api_key_prefix, api_key_hash, environment, scopes, rate_limit_per_minute)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), clientId, issued.keyId, issued.prefix, issued.hash,
        environment.toUpperCase(), JSON.stringify(scopes), limit,
      ],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }

  console.log(`${createdClient ? 'Client created' : 'Additional key created'}: ${code}`);
  console.log(`Key ID: ${issued.keyId}`);
  console.log(`Scopes: ${scopes.join(', ')}`);
  console.log('Copy this API key into the client’s password manager now; it cannot be retrieved again:');
  console.log(issued.plaintext);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
