import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '../src/errors.js';
import { createWarehouseOperations, decodeDeliveryCursor, encodeDeliveryCursor } from '../src/warehouseOperations.js';
import type { Pool } from 'mysql2/promise';
import type { LabelStorage } from '../src/labelStorage.js';
import type { WarehouseSession } from '../src/warehouseIdentity.js';
import { expiryIds, expirySqlFixture } from './labelExpirySqlFixture.js';

const session: WarehouseSession = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  userName: 'Operator',
  loginName: 'operator',
  email: 'operator@example.com',
  phone: null,
  platformRole: null,
  passwordState: 'ACTIVE',
  warehouseId: '00000000-0000-4000-8000-000000000003',
  warehouseCode: 'jfk',
  warehouseName: 'JFK',
  membershipId: '00000000-0000-4000-8000-000000000004',
  roleId: '00000000-0000-4000-8000-000000000005',
  roleName: '仓库操作员',
  permissions: ['scan.use', 'print.submit'],
  workspaces: [],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 120_000).toISOString(),
};
const storage = {} as LabelStorage;

for (const [expiresAt, available] of [
  ['2026-09-18 01:00:00.000', true],
  ['2026-09-18 00:00:00.001', true],
  ['2026-09-18 00:00:00.000', false],
  ['2026-09-17 23:59:59.999', false],
] as const) {
  for (const operation of ['list', 'print'] as const) {
    it(`${operation} uses UTC expiry ${expiresAt} in a +08:00 session`, async () => {
      const sqlDb = expirySqlFixture(expiresAt);
      const execute = async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM workstations')) return [[{ id: 'workstation' }]];
        if (sql.trimStart().startsWith('SELECT')) {
          return [sqlDb.select(sql, params).map(row => ({ ...row, updated_at: new Date('2026-09-11T00:00:00Z') }))];
        }
        return [{ affectedRows: 1 }];
      };
      const connection = { execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
      const operations = createWarehouseOperations({
        mysql: { execute, getConnection: async () => connection } as unknown as Pool,
        storage, outboundWebhooks: { enqueuePrintAttempt: async () => 'event' },
      });
      try {
        if (operation === 'list') {
          const page = await operations.listShipments(session, {});
          assert.equal(page.shipments[0].labelAsset?.id ?? null, available ? expiryIds.asset : null);
        } else {
          const attempt = operations.recordPrintAttempt(session, {
            workstationId: '00000000-0000-4000-8000-000000000005', shipmentId: expiryIds.shipment,
            labelAssetId: expiryIds.asset, clientAttemptId: '00000000-0000-4000-8000-000000000009',
            outcome: 'SUBMITTED', occurredAt: new Date().toISOString(),
          });
          if (available) assert.equal((await attempt).outcome, 'SUBMITTED');
          else await assert.rejects(attempt, { code: 'PRINT_TARGET_STALE' });
        }
      } finally { sqlDb.close(); }
    });
  }
}

describe('warehouse delivery cursor', () => {
  it('round-trips an unsigned database revision without losing precision', () => {
    const cursor = encodeDeliveryCursor({ revision: '18446744073709551615' });
    assert.deepEqual(decodeDeliveryCursor(cursor), { revision: '18446744073709551615' });
  });

  it('rejects forged or malformed cursor values', () => {
    assert.throws(
      () => decodeDeliveryCursor(Buffer.from(JSON.stringify({ revision: '-1' })).toString('base64url')),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_CURSOR',
    );
    assert.throws(
      () => decodeDeliveryCursor('not-json'),
      (error: unknown) => error instanceof ApiError && error.status === 400,
    );
  });
});

describe('global warehouse visibility', () => {
  it('lists shipments from every upstream client without a warehouse-client join', async () => {
    let statement = '';
    let parameters: unknown[] = [];
    const mysql = {
      execute: async (sql: string, values: unknown[]) => {
        statement = sql;
        parameters = values;
        return [[]];
      },
    } as unknown as Pool;
    const outboundWebhooks = { enqueuePrintAttempt: async () => 'unused' };

    const result = await createWarehouseOperations({ mysql, storage, outboundWebhooks }).listShipments(session, {});

    assert.deepEqual(result.shipments, []);
    assert.doesNotMatch(statement, /warehouse_client_access/);
    assert.deepEqual(parameters, [201]);
  });
});

describe('PDF availability', () => {
  it('rejects an expired PDF before opening storage even when its pointer is still current', async () => {
    let opened = false;
    const mysql = {
      execute: async () => [[{
        id: 'old-label', content_sha256: 'a'.repeat(64), content_type: 'application/pdf',
        byte_size: 20, storage_key: 'labels/old.pdf', expires_at: new Date('2020-01-01'), bytes_deleted_at: null,
      }]],
    } as unknown as Pool;
    const labelStorage = { open: async () => { opened = true; throw new Error('should not open'); } } as unknown as LabelStorage;
    const operations = createWarehouseOperations({ mysql, storage: labelStorage, outboundWebhooks: { enqueuePrintAttempt: async () => 'unused' } });
    await assert.rejects(operations.openLabel(session, 'old-label'),
      (error: unknown) => error instanceof ApiError && error.code === 'LABEL_EXPIRED' && error.status === 410);
    assert.equal(opened, false);
  });
});

describe('warehouse print attempts', () => {
  it('records QZ acceptance without promoting the shipment to physically printed', async () => {
    const statements: string[] = [];
    let committed = false;
    const connection = {
      beginTransaction: async () => undefined,
      execute: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('FROM workstations')) return [[{ id: '00000000-0000-4000-8000-000000000005' }]];
        if (sql.includes('FROM shipments s')) return [[{
          client_id: '00000000-0000-4000-8000-000000000006',
          shipment_id: '00000000-0000-4000-8000-000000000007',
          label_asset_id: '00000000-0000-4000-8000-000000000008',
        }]];
        return [{ affectedRows: 1 }];
      },
      commit: async () => { committed = true; },
      rollback: async () => undefined,
      release: () => undefined,
    };
    const mysql = { getConnection: async () => connection } as unknown as Pool;
    let enqueued = false;
    const outboundWebhooks = {
      enqueuePrintAttempt: async () => { enqueued = true; return '00000000-0000-4000-8000-000000000010'; },
    };
    const result = await createWarehouseOperations({ mysql, storage, outboundWebhooks }).recordPrintAttempt(session, {
      workstationId: '00000000-0000-4000-8000-000000000005',
      shipmentId: '00000000-0000-4000-8000-000000000007',
      labelAssetId: '00000000-0000-4000-8000-000000000008',
      clientAttemptId: '00000000-0000-4000-8000-000000000009',
      outcome: 'SUBMITTED',
      printerName: 'Warehouse printer',
      occurredAt: new Date().toISOString(),
    });
    assert.equal(result.outcome, 'SUBMITTED');
    assert.equal(committed, true);
    assert.ok(statements.some(sql => sql.includes('INSERT IGNORE INTO print_attempts')));
    assert.ok(statements.some(sql => sql.includes('INSERT INTO shipment_events')));
    assert.equal(statements.some(sql => sql.includes('warehouse_client_access')), false);
    assert.equal(enqueued, true);
    assert.equal(statements.some(sql => /UPDATE\s+shipments/i.test(sql)), false);
  });
});
