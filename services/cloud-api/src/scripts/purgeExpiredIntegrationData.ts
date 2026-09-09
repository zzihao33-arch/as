import { createPool } from 'mysql2/promise';
import { createMetadataRetention, parseMetadataRetentionArgs } from '../metadataRetention.js';

// Deliberately separate credentials from the business API's non-DELETE user.
// No dotenv import: operators supply an explicit maintenance environment.
async function main() {
  const options = parseMetadataRetentionArgs(process.argv.slice(2));
  function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error('Missing maintenance database configuration.');
    return value;
  }
  const port = Number(process.env.RETENTION_MYSQL_PORT ?? 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid maintenance database port.');
  const mysql = createPool({
    host: required('RETENTION_MYSQL_HOST'), port,
    database: required('RETENTION_MYSQL_DATABASE'),
    user: required('RETENTION_MYSQL_USER'), password: required('RETENTION_MYSQL_PASSWORD'),
    connectionLimit: 1, timezone: 'Z', charset: 'utf8mb4',
  });
  try {
    console.log(JSON.stringify(await createMetadataRetention({ mysql }).run(options)));
  } finally {
    await mysql.end();
  }
}

main().catch(() => {
  // Driver errors may contain SQL, credentials, or operational details.
  console.error('METADATA_RETENTION_FAILED: check options, maintenance permissions, and database availability.');
  process.exitCode = 1;
});
