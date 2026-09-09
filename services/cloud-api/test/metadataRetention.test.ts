import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'mysql2/promise';
import { createMetadataRetention, parseMetadataRetentionArgs } from '../src/metadataRetention.js';

const clientId = '11111111-1111-4111-8111-111111111111';
function fixture(blockedTable?: string, failDelete = false, extras = false, recentBatchOrderId?: string) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const boundaries: string[] = [];
  const connection = {
    beginTransaction: async () => { boundaries.push('begin'); },
    commit: async () => { boundaries.push('commit'); },
    rollback: async () => { boundaries.push('rollback'); },
    release: () => { boundaries.push('release'); },
    execute: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('AS cutoff')) return [[{ cutoff: new Date('2024-09-09T00:00:00Z') }]];
      if (sql.startsWith('SELECT 1 AS blocked')) {
        assert.match(sql, /o.id = \?/);
        assert.match(sql, /m.operation = 'inbound-batches.upsert'/);
        assert.match(sql, /JSON_EXTRACT\(m.raw_data, '\$\.batchId'\)/);
        assert.equal(params[0], clientId);
        return [recentBatchOrderId === params[1] ? [{ blocked: 1 }] : []];
      }
      if (sql.startsWith('SELECT s.id')) return [[{ id: 'shipment' }]];
      if (sql.includes('AS blocked')) return [[{ id: 'child', blocked: blockedTable && sql.includes(blockedTable) ? 1 : 0 }]];
      if (sql.startsWith('SELECT id, air_pickup_order_id FROM shipments')) return [[{ id: 'shipment', air_pickup_order_id: 'order' }]];
      if (sql.startsWith('SELECT id FROM inbound_messages') || sql.startsWith('SELECT o.id')) return [extras ? [{ id: 'extra' }] : []];
      if (sql.startsWith('DELETE') && failDelete) throw new Error('provider secret');
      return [{ affectedRows: 1 }];
    },
  };
  return { mysql: { getConnection: async () => connection } as unknown as Pool, calls, boundaries };
}

test('maintenance arguments default to dry run and require a bounded tenant scope', () => {
  assert.deepEqual(parseMetadataRetentionArgs(['--client-id', clientId]), { clientId, execute: false, batchSize: 100 });
  assert.equal(parseMetadataRetentionArgs(['--client-id', clientId, '--execute']).execute, true);
  for (const args of [[], ['--client-id', 'all'], ['--client-id', clientId, '--batch-size', '1001'], ['--client-id', clientId, '--oops']]) {
    assert.throws(() => parseMetadataRetentionArgs(args));
  }
});

test('default preview reports eligibility without any mutating statement', async () => {
  const f = fixture();
  const result = await createMetadataRetention(f).run({ clientId });
  assert.equal(result.shipmentsEligible, 1);
  assert.equal(result.shipmentsDeleted, 0);
  assert.ok(f.calls.every(({ sql }) => sql.startsWith('SELECT')));
  assert.ok(f.calls.filter(({ sql }) => !sql.includes('AS cutoff')).every(({ params }) => params.includes(clientId)));
});

test('a child updated after discovery prevents all shipment deletion', async () => {
  const f = fixture('label_assets');
  const result = await createMetadataRetention(f).run({ clientId, execute: true });
  assert.equal(result.shipmentsDeleted, 0);
  assert.equal(result.shipmentsSkipped, 1);
  assert.ok(!f.calls.some(({ sql }) => sql.startsWith('DELETE')));
});

test('a recently created TYG label version prevents shipment and asset deletion', async () => {
  const f = fixture('tyg_label_versions');
  const result = await createMetadataRetention(f).run({ clientId, execute: true });
  assert.equal(result.shipmentsDeleted, 0);
  assert.equal(result.shipmentsSkipped, 1);
  assert.ok(!f.calls.some(({ sql }) => sql.startsWith('DELETE')));
});

test('eligibility queries cover undelivered callbacks, missing bytes deletion and all child clocks', async () => {
  const f = fixture();
  await createMetadataRetention(f).run({ clientId });
  const query = f.calls.find(({ sql }) => sql.startsWith('SELECT s.id'))!;
  assert.match(query.sql, /delivery_status <> 'DELIVERED'/);
  assert.match(query.sql, /bytes_deleted_at IS NULL/);
  assert.match(query.sql, /shipment_id IS NULL/);
  for (const column of ['updated_at', 'occurred_at', 'changed_at', 'received_at', 'completed_at', 'started_at', 'ready_at', 'expires_at']) assert.ok(query.sql.includes(column));
  assert.deepEqual(query.params, [clientId]);
});

test('execution locks shipment before rechecking children and deletes in foreign-key order', async () => {
  const f = fixture();
  const result = await createMetadataRetention(f).run({ clientId, execute: true });
  assert.equal(result.shipmentsDeleted, 1);
  const locks = f.calls.filter(({ sql }) => sql.includes('FOR UPDATE'));
  assert.match(locks[0].sql, /FROM shipments/);
  const deletes = f.calls.filter(({ sql }) => sql.startsWith('DELETE'));
  assert.deepEqual(deletes.map(({ sql }) => /(?:DELETE FROM|DELETE [a-z]+ FROM) (\w+)/.exec(sql)?.[1]),
    ['outbound_webhook_attempts', 'outbound_webhook_events', 'print_attempts', 'print_logs', 'shipment_events', 'shipment_delivery_changes', 'inbound_messages', 'tyg_label_versions', 'label_assets', 'shipments']);
  assert.ok(deletes.every(({ params }) => params.includes(clientId) && params.includes('shipment')));
  assert.ok(f.calls.findIndex(({ sql }) => sql.startsWith('UPDATE shipments')) < f.calls.findIndex(({ sql }) => sql.startsWith('DELETE FROM label_assets')));
});

test('a deletion failure rolls back and does not report success', async () => {
  const f = fixture(undefined, true);
  await assert.rejects(createMetadataRetention(f).run({ clientId, execute: true }));
  assert.ok(f.boundaries.includes('rollback'));
  assert.equal(f.boundaries.filter(x => x === 'commit').length, 0);
});

test('a recent unrelated batch does not prevent an old shipment purge', async () => {
  const f = fixture(undefined, false, false, 'another-order');
  const result = await createMetadataRetention(f).run({ clientId, execute: true });
  assert.equal(result.shipmentsDeleted, 1);
});

test('a recent message for the same batch prevents shipment purge', async () => {
  const f = fixture(undefined, false, false, 'order');
  const result = await createMetadataRetention(f).run({ clientId, execute: true });
  assert.equal(result.shipmentsDeleted, 0);
  assert.equal(result.shipmentsSkipped, 1);
  assert.ok(!f.calls.some(({ sql }) => sql.startsWith('DELETE')));
});

test('batch guards normalize stored raw IDs and qualify overlapping timestamp columns', async () => {
  const f = fixture();
  await createMetadataRetention(f).run({ clientId, execute: true });
  const guards = f.calls.filter(({ sql }) => sql.includes('INNER JOIN air_pickup_orders o'));
  assert.equal(guards.length, 2);
  for (const { sql } of guards) {
    assert.match(sql, /TRIM\(CAST\(JSON_UNQUOTE\(JSON_EXTRACT\(m.raw_data, '\$\.batchId'\)\) AS CHAR CHARACTER SET utf8mb4\)\)/);
    assert.match(sql, /GREATEST\(m.received_at, m.completed_at\)/);
    assert.doesNotMatch(sql, /GREATEST\(received_at,/);
  }
});

test('old standalone messages and order payloads are bounded and scoped without deleting orders', async () => {
  const f = fixture('label_assets', false, true);
  const result = await createMetadataRetention(f).run({ clientId, execute: true, batchSize: 5 });
  assert.equal(result.unassociatedMessagesDeleted, 1);
  assert.equal(result.orderPayloadsCleared, 1);
  const rawDelete = f.calls.find(({ sql }) => sql.startsWith('DELETE FROM inbound_messages'))!;
  assert.match(rawDelete.sql, /shipment_id IS NULL/);
  assert.match(rawDelete.sql, /completed_at IS NOT NULL/);
  assert.deepEqual(rawDelete.params, ['extra', clientId]);
  const clearing = f.calls.find(({ sql }) => sql.startsWith('UPDATE air_pickup_orders'))!;
  assert.match(clearing.sql, /SET o.raw_data = NULL, o.updated_at = o.updated_at/);
  assert.match(clearing.sql, /source_type = 'UPSTREAM'/);
  assert.match(clearing.sql, /NOT EXISTS \(SELECT 1 FROM shipments/);
  assert.deepEqual(clearing.params, ['extra', clientId]);
  assert.ok(!f.calls.some(({ sql }) => /DELETE.*air_pickup_orders/.test(sql)));
});
