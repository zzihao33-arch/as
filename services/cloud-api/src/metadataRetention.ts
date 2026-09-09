import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { Pool } from 'mysql2/promise';

const cutoff = '(CURRENT_TIMESTAMP(3) - INTERVAL 2 YEAR)';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type MetadataRetentionOptions = { clientId: string; execute?: boolean; batchSize?: number };
function validate(options: MetadataRetentionOptions) {
  if (!uuid.test(options.clientId)) throw new Error('A single UUID client-id is required.');
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('batch-size must be 1–1000.');
  return { clientId: options.clientId, execute: options.execute === true, batchSize };
}

export function parseMetadataRetentionArgs(args: string[]) {
  const options: MetadataRetentionOptions = { clientId: '' };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error('Duplicate maintenance option.');
    seen.add(arg);
    if (arg === '--execute') options.execute = true;
    else if (arg === '--client-id') options.clientId = args[++i] ?? '';
    else if (arg === '--batch-size') options.batchSize = Number(args[++i]);
    else throw new Error('Unknown maintenance option.');
  }
  return validate(options);
}

// Every dependency is checked with current locking reads before execution.
// FK inserts require the shipment/event locks; existing mutable children are
// also locked, so callback replay cannot slip between checking and deletion.
const children = [
  // A malformed cross-shipment current pointer must never be cleared through
  // label_assets' ON DELETE SET NULL side effect on an unrelated shipment.
  { from: 'shipments x INNER JOIN label_assets a ON a.id = x.current_label_asset_id', scope: 'a.shipment_id = s.id AND x.id <> a.shipment_id', tenant: 'x.client_id', recent: '1 = 1' },
  { from: 'outbound_webhook_events x', scope: 'x.shipment_id = s.id', tenant: 'x.client_id',
    recent: `x.delivery_status <> 'DELIVERED' OR x.delivered_at IS NULL OR GREATEST(x.created_at, x.updated_at, x.delivered_at, COALESCE(x.last_attempt_at, x.created_at)) >= ${cutoff}` },
  { from: 'outbound_webhook_attempts x INNER JOIN outbound_webhook_events e ON e.id = x.event_id', scope: 'e.shipment_id = s.id', tenant: 'e.client_id',
    recent: `x.completed_at IS NULL OR x.outcome = 'IN_PROGRESS' OR GREATEST(x.started_at, x.completed_at) >= ${cutoff}` },
  { from: 'print_attempts x', scope: 'x.shipment_id = s.id', tenant: 'x.client_id', recent: `GREATEST(x.created_at, x.occurred_at) >= ${cutoff}` },
  { from: 'print_logs x', scope: 'x.shipment_id = s.id', tenant: 'x.client_id', recent: `GREATEST(x.created_at, x.occurred_at) >= ${cutoff}` },
  { from: 'shipment_events x', scope: 'x.shipment_id = s.id', tenant: 'x.client_id', recent: `GREATEST(x.created_at, x.occurred_at) >= ${cutoff}` },
  { from: 'shipment_delivery_changes x', scope: 'x.shipment_id = s.id', tenant: 'x.client_id', recent: `x.changed_at >= ${cutoff}` },
  { from: 'inbound_messages x', scope: 'x.shipment_id = s.id', tenant: 'x.client_id',
    recent: `x.processing_status <> 'COMPLETED' OR x.completed_at IS NULL OR GREATEST(x.received_at, x.completed_at) >= ${cutoff}` },
  // Version rows have no client_id: derive tenant scope from their shipment.
  // They reference both shipment and asset with RESTRICT foreign keys.
  { from: 'tyg_label_versions x INNER JOIN shipments owner ON owner.id = x.shipment_id', scope: 'x.shipment_id = s.id', tenant: 'owner.client_id',
    recent: `x.created_at >= ${cutoff}` },
  { from: 'label_assets x', scope: 'x.shipment_id = s.id', tenant: 'x.client_id',
    recent: `x.bytes_deleted_at IS NULL OR x.asset_status = 'STORING' OR GREATEST(x.created_at, x.updated_at, COALESCE(x.ready_at, x.created_at), x.expires_at, x.bytes_deleted_at) >= ${cutoff}` },
];
const recentUnassociated = `m.processing_status <> 'COMPLETED' OR m.completed_at IS NULL OR GREATEST(m.received_at, m.completed_at) >= ${cutoff}`;
// Batch id follows the order's case-insensitive database identity, not JSON's
// binary string collation. Other batches for this client must not block purge.
const batchAssociation = `m.client_id = o.client_id AND m.operation = 'inbound-batches.upsert'
  AND TRIM(CAST(JSON_UNQUOTE(JSON_EXTRACT(m.raw_data, '$.batchId')) AS CHAR CHARACTER SET utf8mb4))
      COLLATE utf8mb4_0900_ai_ci = o.external_batch_id`;
const oldMessage = `processing_status = 'COMPLETED' AND completed_at IS NOT NULL AND received_at < ${cutoff} AND completed_at < ${cutoff}`;
const oldOrder = `o.source_type = 'UPSTREAM' AND o.raw_data IS NOT NULL AND o.updated_at < ${cutoff}
  AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.air_pickup_order_id = o.id)`;

export function createMetadataRetention({ mysql }: { mysql: Pool }) {
  return {
    async run(input: MetadataRetentionOptions) {
      const options = validate(input);
      const { clientId, batchSize, execute } = options;
      const result = { dryRun: !execute, shipmentsEligible: 0, shipmentsDeleted: 0, shipmentsSkipped: 0,
        unassociatedMessagesEligible: 0, unassociatedMessagesDeleted: 0, orderPayloadsEligible: 0, orderPayloadsCleared: 0 };
      const connection = await mysql.getConnection();
      try {
        const eligibility = children.map(c => `AND NOT EXISTS (SELECT 1 FROM ${c.from}
          WHERE ${c.scope} AND (${c.tenant} <> s.client_id OR ${c.recent}))`).join('\n');
        const [shipments] = await connection.execute<(RowDataPacket & { id: string })[]>(
          `SELECT s.id FROM shipments s WHERE s.client_id = ? AND GREATEST(s.created_at, s.updated_at) < ${cutoff}
           ${eligibility}
           AND NOT EXISTS (SELECT 1 FROM inbound_messages m INNER JOIN air_pickup_orders o ON ${batchAssociation}
             WHERE o.id = s.air_pickup_order_id AND m.client_id = s.client_id AND m.shipment_id IS NULL AND (${recentUnassociated}))
           ORDER BY s.id LIMIT ${batchSize}`, [clientId],
        );
        result.shipmentsEligible = shipments.length;
        if (execute) for (const shipment of shipments) {
          await connection.beginTransaction();
          const [locked] = await connection.execute<(RowDataPacket & { air_pickup_order_id: string | null })[]>(
            `SELECT id, air_pickup_order_id FROM shipments WHERE id = ? AND client_id = ? AND GREATEST(created_at, updated_at) < ${cutoff} FOR UPDATE`, [shipment.id, clientId],
          );
          let blocked = locked.length === 0;
          for (const child of children) {
            if (blocked) break;
            const [rows] = await connection.execute<(RowDataPacket & { blocked: number })[]>(
              `SELECT CASE WHEN ${child.tenant} <> ? OR ${child.recent} THEN 1 ELSE 0 END AS blocked
               FROM ${child.from} WHERE ${child.scope.replace('s.id', '?')} FOR UPDATE`, [clientId, shipment.id],
            );
            blocked = rows.some(row => Number(row.blocked) === 1);
          }
          if (!blocked && locked[0].air_pickup_order_id) {
            const [recent] = await connection.execute<RowDataPacket[]>(
              `SELECT 1 AS blocked FROM inbound_messages m INNER JOIN air_pickup_orders o ON ${batchAssociation}
               WHERE m.client_id = ? AND o.id = ? AND m.shipment_id IS NULL
               AND (${recentUnassociated}) FOR UPDATE`, [clientId, locked[0].air_pickup_order_id],
            );
            blocked = recent.length > 0;
          }
          if (blocked) {
            await connection.rollback();
            result.shipmentsSkipped++;
            continue;
          }
          await connection.execute(
            `DELETE a FROM outbound_webhook_attempts a INNER JOIN outbound_webhook_events e ON e.id = a.event_id
             WHERE e.shipment_id = ? AND e.client_id = ?`, [shipment.id, clientId],
          );
          for (const table of ['outbound_webhook_events', 'print_attempts', 'print_logs', 'shipment_events', 'shipment_delivery_changes', 'inbound_messages']) {
            await connection.execute(`DELETE FROM ${table} WHERE shipment_id = ? AND client_id = ?`, [shipment.id, clientId]);
          }
          await connection.execute(
            `DELETE v FROM tyg_label_versions v INNER JOIN shipments owner ON owner.id = v.shipment_id
             WHERE v.shipment_id = ? AND owner.client_id = ?`, [shipment.id, clientId],
          );
          await connection.execute('UPDATE shipments SET current_label_asset_id = NULL WHERE id = ? AND client_id = ?', [shipment.id, clientId]);
          await connection.execute('DELETE FROM label_assets WHERE shipment_id = ? AND client_id = ?', [shipment.id, clientId]);
          await connection.execute('DELETE FROM shipments WHERE id = ? AND client_id = ?', [shipment.id, clientId]);
          await connection.commit();
          result.shipmentsDeleted++;
        }

        const [messages] = await connection.execute<(RowDataPacket & { id: string })[]>(
          `SELECT id FROM inbound_messages WHERE client_id = ? AND shipment_id IS NULL AND ${oldMessage} ORDER BY id LIMIT ${batchSize}`, [clientId],
        );
        result.unassociatedMessagesEligible = messages.length;
        if (execute) for (const message of messages) {
          // One conditional statement locks and rechecks the row atomically.
          const [deleted] = await connection.execute<ResultSetHeader>(
            `DELETE FROM inbound_messages WHERE id = ? AND client_id = ? AND shipment_id IS NULL AND ${oldMessage}`, [message.id, clientId],
          );
          result.unassociatedMessagesDeleted += deleted.affectedRows;
        }
        const [orders] = await connection.execute<(RowDataPacket & { id: string })[]>(
          `SELECT o.id FROM air_pickup_orders o WHERE o.client_id = ? AND ${oldOrder} ORDER BY o.id LIMIT ${batchSize}`, [clientId],
        );
        result.orderPayloadsEligible = orders.length;
        if (execute) for (const order of orders) {
          await connection.beginTransaction();
          await connection.execute('SELECT id FROM air_pickup_orders WHERE id = ? AND client_id = ? FOR UPDATE', [order.id, clientId]);
          const [cleared] = await connection.execute<ResultSetHeader>(
            `UPDATE air_pickup_orders o SET o.raw_data = NULL, o.updated_at = o.updated_at WHERE o.id = ? AND o.client_id = ? AND ${oldOrder}`, [order.id, clientId],
          );
          await connection.commit();
          result.orderPayloadsCleared += cleared.affectedRows;
        }
        return result;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}
