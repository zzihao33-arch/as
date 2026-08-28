import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { closeConnections, mysql } from '../db.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1]?.trim();
}

async function main(): Promise<void> {
  const clientCode = option('--client-code');
  if (!clientCode || !/^[a-zA-Z0-9_-]{2,64}$/.test(clientCode)) {
    throw new Error('Usage: npm run disable-client-callback -- --client-code <code>');
  }
  const connection = await mysql.getConnection();
  try {
    await connection.beginTransaction();
    const [clients] = await connection.execute<(RowDataPacket & { id: string })[]>(
      `SELECT id FROM clients WHERE client_code = ? LIMIT 1 FOR UPDATE`, [clientCode],
    );
    if (!clients[0]) throw new Error('The client code does not exist.');
    const clientId = clients[0].id;
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE client_callback_endpoints SET endpoint_status = 'DISABLED'
       WHERE client_id = ? AND endpoint_status = 'ACTIVE'`,
      [clientId],
    );
    if (result.affectedRows === 0) throw new Error('No active callback exists for this client.');
    await connection.execute(
      `UPDATE outbound_webhook_attempts a
       INNER JOIN outbound_webhook_events e ON e.id = a.event_id
       SET a.outcome = 'RETRY', a.error_code = 'ENDPOINT_DISABLED', a.completed_at = NOW(3)
       WHERE e.client_id = ? AND a.outcome = 'IN_PROGRESS'`,
      [clientId],
    );
    await connection.execute(
      `UPDATE outbound_webhook_events
       SET endpoint_id = NULL, delivery_status = 'WAITING_CONFIGURATION', next_attempt_at = NULL,
           lease_token = NULL, lease_expires_at = NULL, last_error_code = 'ENDPOINT_DISABLED',
           last_error_message = 'Callback endpoint disabled by an operator.'
       WHERE client_id = ? AND delivery_status IN ('PENDING', 'RETRY_SCHEDULED', 'DELIVERING')`,
      [clientId],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
  console.log(`Callback disabled for client: ${clientCode}`);
  console.log('A request already in flight may still reach the receiver; reject the old signing secret upstream if immediate revocation is required.');
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
