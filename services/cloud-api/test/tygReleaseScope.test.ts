import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createSharedWarehouseWork } from '../src/sharedWarehouseWork.js';
import { createWarehouseIdentity } from '../src/warehouseIdentity.js';
import { hashWarehousePassword, verifyWarehousePassword } from '../src/warehouseSecurity.js';
import type { WarehouseSession } from '../src/warehouseIdentity.js';

const batchId = '00000000-0000-4000-8000-000000000001';
const session = {
  userId: 'user-a', sessionId: 'session-a', loginName: 'operator', warehouseId: null,
  passwordState: 'CHANGE_REQUIRED',
} as WarehouseSession;
const audit = { requestId: 'scope-test', ip: '127.0.0.1' };

for (const passwordState of ['CHANGE_REQUIRED', 'ACTIVE'] as const) {
  for (const length of [5, 15]) {
    test(`${passwordState} rejects a ${length}-character new password before database access`, async () => {
      let reads = 0;
      const identity = createWarehouseIdentity({
        mysql: { execute: async () => { reads++; return [[]]; } } as never,
        redis: {} as never, sessionLifetimeHours: 8,
      });
      await assert.rejects(identity.changePassword({ ...session, passwordState }, {
        currentPassword: 'previous-password', newPassword: 'x'.repeat(length),
      }, audit), { code: 'WEAK_PASSWORD', status: 400 });
      assert.equal(reads, 0);
    });
  }

  test(`${passwordState} accepts 16 characters, stores a verifiable hash and revokes other sessions`, async () => {
    const oldHash = await hashWarehousePassword('previous-password');
    let newHash = '';
    let revoked = false;
    let committed = false;
    let audited = false;
    const connection = {
      beginTransaction: async () => undefined,
      commit: async () => { committed = true; },
      rollback: async () => undefined,
      release: () => undefined,
      execute: async (sql: string, params: unknown[]) => {
        if (sql.includes('UPDATE warehouse_users')) {
          assert.equal(params[1], 'user-a');
          newHash = String(params[0]);
        } else if (sql.includes('UPDATE warehouse_sessions')) {
          assert.deepEqual(params, ['user-a', 'session-a']);
          assert.match(sql, /id <> \?/);
          revoked = true;
        } else if (sql.includes('INSERT INTO warehouse_security_audit_events')) {
          assert.equal(params[1], 'PASSWORD_CHANGED');
          audited = true;
        } else throw new Error(`Unexpected SQL: ${sql}`);
        return [{ affectedRows: 1 }];
      },
    };
    const identity = createWarehouseIdentity({
      mysql: {
        execute: async (sql: string, params: unknown[]) => {
          assert.match(sql, /SELECT password_hash FROM warehouse_users/);
          assert.deepEqual(params, ['user-a']);
          return [[{ password_hash: oldHash }]];
        },
        getConnection: async () => connection,
      } as never,
      redis: {} as never, sessionLifetimeHours: 8,
    });
    await identity.changePassword({ ...session, passwordState }, {
      currentPassword: 'previous-password', newPassword: '1234567890abcdef',
    }, audit);
    assert.equal(await verifyWarehousePassword('1234567890abcdef', newHash), true);
    assert.equal(await verifyWarehousePassword('previous-password', newHash), false);
    assert.ok(revoked && committed && audited);
  });
}

for (const fixture of [
  { name: 'missing PDF', status: 'DRAFT', mappings: 2, pdfs: 1, allowed: false },
  { name: 'empty draft', status: 'DRAFT', mappings: 0, pdfs: 0, allowed: false },
  { name: 'complete draft', status: 'DRAFT', mappings: 2, pdfs: 2, allowed: true },
  { name: 'already active', status: 'ACTIVE', mappings: 2, pdfs: 2, allowed: false },
  { name: 'closed batch', status: 'CLOSED', mappings: 2, pdfs: 2, allowed: false },
]) {
  test(`batch publication preserves the legacy contract: ${fixture.name}`, async t => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec(`CREATE TABLE warehouse_work_batches (
      id TEXT PRIMARY KEY, batch_status TEXT, mapping_count INTEGER, pdf_count INTEGER,
      published_at TEXT, closed_at TEXT, version INTEGER);
      CREATE TABLE warehouse_work_batch_changes (batch_id TEXT, change_type TEXT);`);
    db.prepare('INSERT INTO warehouse_work_batches VALUES (?, ?, ?, ?, NULL, NULL, 1)')
      .run(batchId, fixture.status, fixture.mappings, fixture.pdfs);
    const work = createSharedWarehouseWork({
      mysql: {
        execute: async (sql: string, params: (string | number)[]) => {
          const result = db.prepare(sql.replaceAll('CURRENT_TIMESTAMP(3)', 'CURRENT_TIMESTAMP')).run(...params);
          return [{ affectedRows: Number(result.changes) }];
        },
      } as never,
      storage: {} as never,
    });
    if (fixture.allowed) {
      assert.deepEqual(await work.publishBatch(session, batchId), { id: batchId, status: 'ACTIVE' });
    } else {
      await assert.rejects(work.publishBatch(session, batchId), { code: 'BATCH_NOT_PUBLISHABLE', status: 409 });
    }
    const row = db.prepare('SELECT batch_status, version, published_at FROM warehouse_work_batches').get()!;
    assert.equal(row.batch_status, fixture.allowed ? 'ACTIVE' : fixture.status);
    assert.equal(row.version, fixture.allowed ? 2 : 1);
    assert.equal(row.published_at !== null, fixture.allowed);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM warehouse_work_batch_changes').get()!.n, fixture.allowed ? 1 : 0);
  });
}

for (const fixture of [
  { status: 'ACTIVE', assetStatus: null, allowed: false },
  { status: 'ACTIVE', assetStatus: 'READY', allowed: false },
  { status: 'CLOSED', assetStatus: null, allowed: false },
  { status: 'DRAFT', assetStatus: 'READY', allowed: true },
]) {
  test(`shared label upload remains draft-only: ${fixture.status}/${fixture.assetStatus}`, async () => {
    let rolledBack = false;
    let committed = false;
    let mutations = 0;
    let storageWrites = 0;
    const pdf = { content: Buffer.from('%PDF-1.4'), sha256: 'a'.repeat(64), byteSize: 8 };
    const connection = {
      beginTransaction: async () => undefined,
      commit: async () => { committed = true; },
      rollback: async () => { rolledBack = true; },
      release: () => undefined,
      execute: async (sql: string) => {
        if (sql.includes('FROM warehouse_work_batch_items')) return [[{
          id: 'item-a', batch_status: fixture.status,
          label_asset_id: fixture.assetStatus ? 'asset-a' : null, asset_status: fixture.assetStatus,
        }]];
        if (sql.includes('FROM warehouse_work_batch_assets')) return [[{
          id: 'asset-a', storage_key: 'batch/label.pdf', content_sha256: pdf.sha256,
          content_type: 'application/pdf', byte_size: 8, asset_status: 'READY',
        }]];
        if (sql.includes('UPDATE warehouse_work_batch_items')) { mutations++; return [{ affectedRows: 1 }]; }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const work = createSharedWarehouseWork({
      mysql: { getConnection: async () => connection } as never,
      storage: { put: async () => { storageWrites++; } } as never,
    });
    const upload = () => work.storeItemLabel(session, batchId, 'FIRST123', 'FIRST123.pdf', pdf);
    if (fixture.allowed) {
      assert.deepEqual(await upload(), { id: 'asset-a', itemId: 'item-a', sha256: pdf.sha256, byteSize: 8, reused: true });
    } else {
      await assert.rejects(upload(), { code: 'BATCH_NOT_EDITABLE', status: 409 });
    }
    assert.equal(mutations, fixture.allowed ? 1 : 0);
    assert.equal(committed, fixture.allowed);
    assert.equal(rolledBack, !fixture.allowed);
    assert.equal(storageWrites, 0);
  });
}
