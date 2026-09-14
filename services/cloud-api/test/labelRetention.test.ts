import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'mysql2/promise';
import type { LabelStorage } from '../src/labelStorage.js';
import { createLabelRetentionWorker } from '../src/labelRetention.js';
import { expiryIds, expirySqlFixture } from './labelExpirySqlFixture.js';

// MySQL is an external boundary: these fixtures exercise worker decisions and
// transaction ordering. Real row-lock behavior needs the deployment smoke test.
function fixture(options: { lock?: number; renewed?: boolean; alreadyRenewed?: boolean; replaced?: boolean; failures?: number } = {}) {
  const calls: string[] = [];
  let checks = 0;
  let deletes = 0;
  let pointer: string | null = options.replaced ? 'new-asset' : 'asset';
  let expired = false;
  let deleted = false;
  const asset = { id: 'asset', client_id: 'client', shipment_id: 'shipment', storage_key: 'labels/old.pdf' };
  const connection = {
    beginTransaction: async () => { calls.push('begin'); },
    commit: async () => { calls.push('commit'); },
    rollback: async () => { calls.push('rollback'); },
    release: () => { calls.push('release'); },
    destroy: () => { calls.push('destroy'); },
    execute: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('GET_LOCK')) return [[{ acquired: options.lock ?? 1 }]];
      if (sql.includes('RELEASE_LOCK')) { calls.push('unlock'); return [[{ released: 1 }]]; }
      if (sql.includes('FROM shipments')) { calls.push('shipment-lock'); return [[{ id: 'shipment', current_label_asset_id: pointer }]]; }
      if (sql.includes('FROM label_assets')) {
        if (!sql.includes('FOR UPDATE')) return [[asset]];
        calls.push('asset-lock'); checks++;
        assert.ok(sql.includes('expires_at <= UTC_TIMESTAMP(3)'));
        assert.ok(sql.includes('storage_key = ?'));
        assert.equal(params[1], asset.storage_key);
        return [options.alreadyRenewed || (options.renewed && checks === 2) ? [] : [{ ...asset, asset_status: expired ? 'FAILED' : 'READY' }]];
      }
      if (sql.includes('UPDATE shipments')) { assert.ok(sql.includes('current_label_asset_id = ?')); pointer = null; calls.push('clear'); }
      if (sql.includes('LABEL_UNAVAILABLE')) calls.push('event');
      if (sql.includes("failure_code = 'LABEL_EXPIRED'")) { expired = true; calls.push('expire'); }
      if (sql.includes('SET bytes_deleted_at')) { deleted = true; calls.push('mark-deleted'); }
      assert.ok(!/DELETE FROM/i.test(sql), 'metadata must remain');
      return [{ affectedRows: 1 }];
    },
  };
  const storage = { remove: async (key: string) => {
    assert.equal(key, 'labels/old.pdf'); calls.push('remove'); deletes++;
    if (deletes <= (options.failures ?? 0)) throw new Error('private provider details');
  } } as LabelStorage;
  return { mysql: { getConnection: async () => connection } as unknown as Pool, storage, calls,
    state: () => ({ pointer, expired, deleted, deletes }) };
}

test('expires current PDF before removal and retains metadata with ordered locks', async () => {
  const f = fixture();
  const result = await createLabelRetentionWorker(f).runOnce();
  assert.equal(result.deleted, 1);
  assert.deepEqual(f.state(), { pointer: null, expired: true, deleted: true, deletes: 1 });
  assert.deepEqual(f.calls, ['begin', 'shipment-lock', 'asset-lock', 'expire', 'clear', 'event', 'commit',
    'begin', 'shipment-lock', 'asset-lock', 'remove', 'mark-deleted', 'commit', 'unlock', 'release']);
});

for (const candidateAlreadySelected of [false, true]) {
  for (const [expiresAt, expectedDeleted] of [
    ['2026-09-18 01:00:00.000', 0],
    ['2026-09-18 00:00:00.001', 0],
    ['2026-09-18 00:00:00.000', 1],
    ['2026-09-17 23:59:59.999', 1],
  ] as const) {
    test(`UTC expiry ${expiresAt}: deletion=${expectedDeleted}, preselected=${candidateAlreadySelected}`, async () => {
      const sqlDb = expirySqlFixture(expiresAt);
      let removed = 0;
      const connection = {
        beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
        execute: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
          if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
          if (candidateAlreadySelected && sql.includes('FROM label_assets') && !sql.includes('FOR UPDATE')) {
            return [[{ id: expiryIds.asset, shipment_id: expiryIds.shipment, client_id: 'client', storage_key: 'labels/current.pdf' }]];
          }
          if (sql.trimStart().startsWith('SELECT')) return [sqlDb.select(sql, params)];
          return [{ affectedRows: 1 }];
        },
      };
      try {
        const result = await createLabelRetentionWorker({
          mysql: { getConnection: async () => connection } as unknown as Pool,
          storage: { remove: async () => { removed++; } } as unknown as LabelStorage,
        }).runOnce();
        assert.equal(result.deleted, expectedDeleted);
        assert.equal(removed, expectedDeleted, 'must not remove future UTC expirations in a +08:00 session');
      } finally { sqlDb.close(); }
    });
  }
}

test('does not invalidate a replacement pointer', async () => {
  const f = fixture({ replaced: true });
  await createLabelRetentionWorker(f).runOnce();
  assert.equal(f.state().pointer, 'new-asset');
  assert.ok(!f.calls.includes('event'));
});

test('rechecks expiry and storage key after renewal before deleting bytes', async () => {
  const f = fixture({ renewed: true });
  const result = await createLabelRetentionWorker(f).runOnce();
  assert.equal(f.state().deletes, 0);
  assert.equal(result.skipped, 1);
});

test('a candidate renewed before the first row lock is never invalidated', async () => {
  const f = fixture({ alreadyRenewed: true });
  const result = await createLabelRetentionWorker(f).runOnce();
  assert.equal(result.expired, 0);
  assert.deepEqual(f.state(), { pointer: 'asset', expired: false, deleted: false, deletes: 0 });
});

test('retries failed removal while expired metadata remains durable', async () => {
  const f = fixture({ failures: 2 });
  const result = await createLabelRetentionWorker({ ...f, deleteAttempts: 3 }).runOnce();
  assert.equal(result.deleted, 1);
  assert.equal(f.state().deletes, 3);
  assert.ok(f.calls.indexOf('commit') < f.calls.indexOf('remove'));
});

test('exhausted deletion leaves metadata eligible for a later retry', async () => {
  const f = fixture({ failures: 20 });
  const result = await createLabelRetentionWorker({ ...f, deleteAttempts: 2 }).runOnce();
  assert.equal(result.deleteFailures, 1);
  assert.deepEqual(f.state(), { pointer: null, expired: true, deleted: false, deletes: 2 });
  assert.ok(f.calls.includes('rollback'));
});

test('does no work when another worker holds the advisory lock', async () => {
  const f = fixture({ lock: 0 });
  const result = await createLabelRetentionWorker(f).runOnce();
  assert.equal(result.locked, false);
  assert.deepEqual(f.calls, ['release']);
});

test('rejects storage without deletion capability explicitly', () => {
  const f = fixture();
  assert.throws(() => createLabelRetentionWorker({ ...f, storage: {} as LabelStorage }), /LABEL_RETENTION_REMOVE_UNAVAILABLE/);
});

test('rejects unbounded batch and retry settings', () => {
  const f = fixture();
  for (const batchSize of [0, -1, 1001, NaN, 1.5]) assert.throws(() => createLabelRetentionWorker({ ...f, batchSize }), /batchSize/);
  for (const deleteAttempts of [0, 6, Infinity]) assert.throws(() => createLabelRetentionWorker({ ...f, deleteAttempts }), /deleteAttempts/);
});
