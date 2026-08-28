import type { RowDataPacket } from 'mysql2';
import { config } from '../config.js';
import { closeConnections, mysql } from '../db.js';
import { decryptWebhookSecret, encryptWebhookSecret } from '../outboundWebhooks.js';

type EndpointSecretRow = RowDataPacket & {
  id: string;
  client_id: string;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_auth_tag: Buffer;
  encryption_key_version: string;
};

async function main(): Promise<void> {
  const { encryptionKeyVersion, masterKeys } = config.outboundWebhooks;
  const targetKey = masterKeys.get(encryptionKeyVersion);
  if (!targetKey) throw new Error(`No master key is configured for active version ${encryptionKeyVersion}.`);

  const connection = await mysql.getConnection();
  let rotated = 0;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<EndpointSecretRow[]>(
      `SELECT id, client_id, secret_ciphertext, secret_iv, secret_auth_tag, encryption_key_version
       FROM client_callback_endpoints FOR UPDATE`,
    );
    for (const row of rows) {
      if (row.encryption_key_version === encryptionKeyVersion) continue;
      const sourceKey = masterKeys.get(row.encryption_key_version);
      if (!sourceKey) throw new Error(`Missing old master key version ${row.encryption_key_version}; no records were changed.`);
      const secret = decryptWebhookSecret({
        ciphertext: row.secret_ciphertext,
        iv: row.secret_iv,
        authTag: row.secret_auth_tag,
      }, sourceKey, row.client_id, row.encryption_key_version);
      const encrypted = encryptWebhookSecret(secret, targetKey, row.client_id, encryptionKeyVersion);
      await connection.execute(
        `UPDATE client_callback_endpoints
         SET secret_ciphertext = ?, secret_iv = ?, secret_auth_tag = ?, encryption_key_version = ?
         WHERE id = ? AND encryption_key_version = ?`,
        [encrypted.ciphertext, encrypted.iv, encrypted.authTag, encryptionKeyVersion, row.id, row.encryption_key_version],
      );
      rotated += 1;
    }
    await connection.commit();
    console.log(`Callback secrets re-encrypted to ${encryptionKeyVersion}: ${rotated}`);
    console.log('Verify the database version counts and a signed callback before removing any old key from OUTBOUND_WEBHOOK_MASTER_KEYS.');
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
