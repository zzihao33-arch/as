import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '../src/errors.js';
import { createWarehouseOperations, decodeDeliveryCursor, encodeDeliveryCursor } from '../src/warehouseOperations.js';
import type { Pool } from 'mysql2/promise';
import type { LabelStorage } from '../src/labelStorage.js';
import type { WarehouseSession } from '../src/warehouseIdentity.js';

const session: WarehouseSession = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  userName: 'Operator',
  email: 'operator@example.com',
  warehouseId: '00000000-0000-4000-8000-000000000003',
  warehouseCode: 'jfk',
  warehouseName: 'JFK',
  membershipId: '00000000-0000-4000-8000-000000000004',
  role: 'OPERATOR',
};
const storage = {} as LabelStorage;

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
    assert.equal(enqueued, true);
    assert.equal(statements.some(sql => /UPDATE\s+shipments/i.test(sql)), false);
  });
});
