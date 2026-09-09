import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'mysql2/promise';
import { createLabelAssetModule } from '../src/labelAssets.js';
import type { LabelStorage } from '../src/labelStorage.js';

const client = {
  id: 'client-1',
  apiKeyId: 'api-key-1',
  scopes: ['labels:write'] as const,
  rateLimitPerMinute: 60,
};

describe('label asset module', () => {
  it('publishes storage content before making the asset current', async () => {
    const statements: string[] = [];
    const prepareConnection = {
      beginTransaction: async () => undefined,
      execute: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('FROM shipments')) {
          return [[{
            id: 'shipment-1', label_sha256: null, current_label_asset_id: null, status: 'RECEIVED',
          }]];
        }
        if (sql.includes('FROM label_assets')) return [[]];
        return [{ affectedRows: 1 }];
      },
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    };
    const finalizeConnection = {
      beginTransaction: async () => undefined,
      execute: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('FROM shipments')) {
          return [[{
            id: 'shipment-1', label_sha256: null, current_label_asset_id: null, status: 'RECEIVED',
          }]];
        }
        return [{ affectedRows: 1 }];
      },
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    };
    let connectionCount = 0;
    const mysql = {
      getConnection: async () => (connectionCount++ === 0 ? prepareConnection : finalizeConnection),
    } as unknown as Pool;
    let storedKey = '';
    const storage = {
      put: async (key: string) => { storedKey = key; },
      open: async () => { throw new Error('not used'); },
    } as unknown as LabelStorage;
    const content = Buffer.from('%PDF-1.7\n%%EOF\n', 'ascii');

    const result = await createLabelAssetModule({ mysql, storage }).storePushedPdf({
      client: { ...client, scopes: ['labels:write'] },
      requestId: 'request-1',
      firstLegTrackingNo: 'FL-1001',
      pdf: { content, sha256: 'a'.repeat(64), byteSize: content.length },
    });

    assert.match(storedKey, /^labels\/client-1\/uploads\/[a-f0-9-]+\/a{64}\.pdf$/);
    assert.equal(result.shipmentStatus, 'READY_TO_PRINT');
    assert.equal(result.reused, false);
    assert.equal(statements.filter((sql) => sql.includes('INSERT INTO shipment_events')).length, 1);
    assert.ok(statements.findIndex((sql) => sql.includes('INSERT INTO label_assets')) < statements.findIndex((sql) => sql.includes('UPDATE shipments')));
  });

  it('replaces a previous PDF directly without requiring a separate hash declaration update', async () => {
    let stored = false;
    let rolledBack = false;
    const connection = {
      beginTransaction: async () => undefined,
      execute: async (sql: string) => sql.includes('FROM label_assets') ? [[]] : sql.includes('FROM shipments') ? [[{
        id: 'shipment-1',
        label_sha256: 'b'.repeat(64),
        current_label_asset_id: null,
        status: 'PRINTED',
      }]] : [{ affectedRows: 1 }],
      commit: async () => undefined,
      rollback: async () => { rolledBack = true; },
      release: () => undefined,
    };
    const mysql = { getConnection: async () => connection } as unknown as Pool;
    const storage = {
      healthCheck: async () => undefined,
      put: async () => { stored = true; },
      open: async () => { throw new Error('not used'); },
    } as unknown as LabelStorage;

    const result = await createLabelAssetModule({ mysql, storage }).storePushedPdf({
        client: { ...client, scopes: ['labels:write'] },
        requestId: 'request-2',
        firstLegTrackingNo: 'FL-1001',
        pdf: { content: Buffer.from('pdf'), sha256: 'a'.repeat(64), byteSize: 3 },
      });
    assert.equal(result.sha256, 'a'.repeat(64));
    assert.equal(result.shipmentStatus, 'PRINTED');
    assert.equal(rolledBack, false);
    assert.equal(stored, true);
  });
});
