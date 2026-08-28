import type { ResultSetHeader } from 'mysql2';
import { closeConnections, mysql } from '../db.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1]?.trim();
}

async function main(): Promise<void> {
  const keyId = option('--key-id');
  if (!keyId || !/^[a-zA-Z0-9_-]{8,32}$/.test(keyId)) {
    throw new Error('Usage: npm run revoke-client-key -- --key-id <key-id>');
  }

  const [result] = await mysql.execute<ResultSetHeader>(
    `UPDATE integration_api_keys
     SET key_status = 'DISABLED', revoked_at = CURRENT_TIMESTAMP(3)
     WHERE key_id = ? AND key_status = 'ACTIVE'`,
    [keyId],
  );
  if (result.affectedRows !== 1) {
    throw new Error('No active API key was found for that key ID.');
  }
  console.log(`API key revoked: ${keyId}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
