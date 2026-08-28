import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import { config } from '../config.js';
import { closeConnections, mysql } from '../db.js';
import { encryptWebhookSecret, validateCallbackUrl } from '../outboundWebhooks.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1]?.trim();
}

async function main(): Promise<void> {
  const clientCode = option('--client-code');
  const callbackUrl = option('--url');
  const signingSecret = process.env.CMHUB_WEBHOOK_SIGNING_SECRET ?? '';
  const masterKey = config.outboundWebhooks.masterKeys.get(config.outboundWebhooks.encryptionKeyVersion);
  if (!clientCode || !/^[a-zA-Z0-9_-]{2,64}$/.test(clientCode) || !callbackUrl) {
    throw new Error('Usage: CMHUB_WEBHOOK_SIGNING_SECRET=<secret> npm run configure-client-callback -- --client-code <code> --url <https-url>');
  }
  validateCallbackUrl(callbackUrl, config.environment);
  if (Buffer.byteLength(signingSecret, 'utf8') < 32 || Buffer.byteLength(signingSecret, 'utf8') > 256) {
    throw new Error('CMHUB_WEBHOOK_SIGNING_SECRET must contain 32 to 256 UTF-8 bytes and is intentionally not accepted in argv.');
  }
  if (!masterKey) throw new Error('The active OUTBOUND_WEBHOOK master-key version must be configured before storing a callback secret.');

  const connection = await mysql.getConnection();
  try {
    await connection.beginTransaction();
    const [clients] = await connection.execute<(RowDataPacket & { id: string })[]>(
      `SELECT id FROM clients WHERE client_code = ? AND client_status = 'ACTIVE' LIMIT 1 FOR UPDATE`,
      [clientCode],
    );
    const clientId = clients[0]?.id;
    if (!clientId) throw new Error('The client code does not exist or is disabled.');
    const encrypted = encryptWebhookSecret(signingSecret, masterKey, clientId, config.outboundWebhooks.encryptionKeyVersion);
    await connection.execute(
      `INSERT INTO client_callback_endpoints
         (id, client_id, callback_url, secret_ciphertext, secret_iv, secret_auth_tag,
          encryption_key_version, signing_version, endpoint_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'HMAC_SHA256_V1', 'ACTIVE')
       ON DUPLICATE KEY UPDATE
         callback_url = VALUES(callback_url), secret_ciphertext = VALUES(secret_ciphertext),
         secret_iv = VALUES(secret_iv), secret_auth_tag = VALUES(secret_auth_tag),
         encryption_key_version = VALUES(encryption_key_version), signing_version = VALUES(signing_version),
         endpoint_status = 'ACTIVE'`,
      [randomUUID(), clientId, callbackUrl, encrypted.ciphertext, encrypted.iv, encrypted.authTag,
        config.outboundWebhooks.encryptionKeyVersion],
    );
    const [endpoints] = await connection.execute<(RowDataPacket & { id: string })[]>(
      `SELECT id FROM client_callback_endpoints WHERE client_id = ? LIMIT 1`, [clientId],
    );
    await connection.execute(
      `UPDATE outbound_webhook_events
       SET endpoint_id = ?, delivery_status = 'PENDING', next_attempt_at = NOW(3)
       WHERE client_id = ? AND delivery_status = 'WAITING_CONFIGURATION'`,
      [endpoints[0].id, clientId],
    );
    await connection.commit();
    console.log(`Active callback configured for client: ${clientCode}`);
    console.log('Waiting callback events were queued. The URL and signing secret were not printed.');
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
