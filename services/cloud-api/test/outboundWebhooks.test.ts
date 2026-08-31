import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import {
  classifyWebhookResponse,
  createOutboundWebhooks,
  decryptWebhookSecret,
  encryptWebhookSecret,
  retryDelayMs,
  signWebhookPayload,
  validateCallbackUrl,
} from '../src/outboundWebhooks.js';
import { ApiError } from '../src/errors.js';

describe('outbound webhook signing', () => {
  it('encrypts signing secrets at rest and authenticates encryption context', () => {
    const key = Buffer.alloc(32, 7);
    const encrypted = encryptWebhookSecret('a-secret-that-is-at-least-32-bytes', key, 'client-1', 'v1');
    assert.notEqual(encrypted.ciphertext.toString('utf8'), 'a-secret-that-is-at-least-32-bytes');
    assert.equal(decryptWebhookSecret(encrypted, key, 'client-1', 'v1'), 'a-secret-that-is-at-least-32-bytes');
    assert.throws(() => decryptWebhookSecret(encrypted, key, 'client-2', 'v1'));
  });

  it('signs the exact timestamp and body bytes', () => {
    const body = '{"eventId":"1"}';
    assert.equal(signWebhookPayload('secret', 123, body), 'v1=97bb01b97077e67090795b42096c4f8fb85129a183540fb56d8bcfc1b4bacc36');
    assert.notEqual(signWebhookPayload('secret', 123, `${body}\n`), signWebhookPayload('secret', 123, body));
  });
});

describe('outbound webhook delivery policy', () => {
  it('delivers 2xx, retries transient failures, and dead-letters permanent 4xx', () => {
    assert.equal(classifyWebhookResponse(204), 'DELIVERED');
    assert.equal(classifyWebhookResponse(429), 'RETRY');
    assert.equal(classifyWebhookResponse(503), 'RETRY');
    assert.equal(classifyWebhookResponse(422), 'DEAD_LETTER');
  });

  it('uses bounded exponential retry delays', () => {
    assert.equal(retryDelayMs(1, null, () => 0.5), 30_000);
    assert.equal(retryDelayMs(20, null, () => 0.5), 3_600_000);
    assert.equal(retryDelayMs(1, '120', () => 0), 120_000);
    assert.equal(retryDelayMs(20, '7200', () => 1), 3_600_000);
  });

  it('requires public HTTPS callbacks in production', () => {
    assert.equal(validateCallbackUrl('https://partner.example.com/hooks/cmhub', 'production').hostname, 'partner.example.com');
    assert.throws(
      () => validateCallbackUrl('http://127.0.0.1:9000/hook', 'production'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_CALLBACK_URL',
    );
    assert.throws(() => validateCallbackUrl('https://10.0.0.1/hook', 'production'));
    assert.throws(() => validateCallbackUrl('https://[::ffff:127.0.0.1]/hook', 'production'));
  });
});

describe('outbound webhook outbox', () => {
  it('lets a warehouse admin inspect events for every upstream client', async () => {
    let statement = '';
    let parameters: unknown[] = [];
    const mysql = {
      query: async (sql: string, values: unknown[]) => {
        statement = sql;
        parameters = values;
        return [[]];
      },
    } as unknown as Pool;
    const module = createOutboundWebhooks({
      mysql,
      options: {
        enabled: false,
        masterKeys: new Map(),
        encryptionKeyVersion: 'v1',
        environment: 'test',
        pollIntervalMs: 5000,
        batchSize: 20,
        leaseSeconds: 60,
        timeoutMs: 10000,
        maxAttempts: 12,
      },
    });

    const events = await module.listForWarehouse({ warehouseId: 'warehouse-1' } as never, {});

    assert.deepEqual(events, []);
    assert.doesNotMatch(statement, /warehouse_client_access/);
    assert.deepEqual(parameters, [null, null]);
  });

  it('persists an exact, minimal event even before a callback is configured', async () => {
    let insertParameters: unknown[] = [];
    const statements: string[] = [];
    const connection = {
      execute: async (sql: string, parameters: unknown[]) => {
        statements.push(sql);
        if (sql.includes('FROM client_callback_endpoints')) return [[]];
        insertParameters = parameters;
        return [{ affectedRows: 1 }];
      },
    } as unknown as PoolConnection;
    const module = createOutboundWebhooks({
      mysql: {} as Pool,
      options: {
        enabled: false,
        masterKeys: new Map(),
        encryptionKeyVersion: 'v1',
        environment: 'test',
        pollIntervalMs: 5000,
        batchSize: 20,
        leaseSeconds: 60,
        timeoutMs: 10000,
        maxAttempts: 12,
      },
    });
    const id = await module.enqueuePrintAttempt(connection, {
      clientId: 'client-1',
      shipmentId: 'shipment-1',
      printAttemptId: 'attempt-1',
      outcome: 'SUBMITTED',
      occurredAt: '2026-08-28T18:22:03.000Z',
      firstLegTrackingNo: 'FIRST-1',
      courierTrackingNo: 'LAST-1',
      carrier: 'USPS',
      shipmentStatus: 'READY_TO_PRINT',
      shipmentVersion: 2,
      printerName: 'Printer 1',
      message: null,
      warehouseCode: 'jfk',
    });
    const body = JSON.parse(String(insertParameters[6]));
    assert.equal(body.eventId, id);
    assert.equal(body.eventType, 'shipment.print.submitted');
    assert.equal(body.data.shipment.firstLegTrackingNo, 'FIRST-1');
    assert.equal('recipientName' in body.data.shipment, false);
    assert.equal(insertParameters[8], 'WAITING_CONFIGURATION');
    assert.equal(insertParameters[9], null);
    assert.match(statements[0], /FROM clients.*FOR UPDATE/);
    assert.match(statements[1], /FROM client_callback_endpoints.*FOR UPDATE/);
  });

  it('claims with a lease, signs once, and finishes only through the matching lease guard', async () => {
    const masterKey = Buffer.alloc(32, 9);
    const encrypted = encryptWebhookSecret('webhook-secret-that-is-at-least-32-bytes', masterKey, 'client-1', 'v1');
    const payload = '{"eventId":"event-1"}';
    const claimStatements: string[] = [];
    const finishCalls: Array<{ sql: string; parameters: unknown[] }> = [];
    const claimConnection = {
      beginTransaction: async () => undefined,
      query: async (sql: string) => {
        claimStatements.push(sql);
        return [[{
          event_id: 'event-1',
          payload_body: payload,
          payload_sha256: 'a'.repeat(64),
          replay_count: 0,
          attempt_count: 0,
          id: 'endpoint-1',
          client_id: 'client-1',
          callback_url: 'https://partner.example.com/hooks/cmhub',
          secret_ciphertext: encrypted.ciphertext,
          secret_iv: encrypted.iv,
          secret_auth_tag: encrypted.authTag,
          encryption_key_version: 'v1',
        }]];
      },
      execute: async (sql: string) => { claimStatements.push(sql); return [{ affectedRows: 1 }]; },
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    };
    const finishConnection = {
      beginTransaction: async () => undefined,
      execute: async (sql: string, parameters: unknown[]) => {
        finishCalls.push({ sql, parameters });
        return [{ affectedRows: 1 }];
      },
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    };
    let connectionNumber = 0;
    const mysql = {
      getConnection: async () => connectionNumber++ === 0 ? claimConnection : finishConnection,
    } as unknown as Pool;
    let signature = '';
    const module = createOutboundWebhooks({
      mysql,
      options: {
        enabled: true,
        masterKeys: new Map([['v1', masterKey]]),
        encryptionKeyVersion: 'v1',
        environment: 'production',
        pollIntervalMs: 5000,
        batchSize: 20,
        leaseSeconds: 60,
        timeoutMs: 10000,
        maxAttempts: 12,
      },
      transport: {
        send: async input => {
          signature = input.headers['X-CMHUB-Signature'];
          assert.equal(input.body, payload);
          return { status: 204, retryAfter: null, body: '' };
        },
      },
    });
    assert.equal(await module.deliverBatch(), 1);
    assert.match(claimStatements[0], /FOR UPDATE SKIP LOCKED/);
    assert.match(signature, /^v1=[0-9a-f]{64}$/);
    assert.ok(finishCalls.some(call => call.sql.includes("outcome = 'IN_PROGRESS'") && call.sql.includes('lease_token = ?')));
    const eventFinish = finishCalls.find(call => call.sql.includes('UPDATE outbound_webhook_events'))!;
    assert.equal(eventFinish.parameters[0], 'DELIVERED');
  });

  it('refuses to start when an active endpoint still needs an old master-key version', async () => {
    const mysql = {
      query: async () => [[{ encryption_key_version: 'v1' }]],
    } as unknown as Pool;
    const module = createOutboundWebhooks({
      mysql,
      options: {
        enabled: true,
        masterKeys: new Map([['v2', Buffer.alloc(32, 2)]]),
        encryptionKeyVersion: 'v2',
        environment: 'production',
        pollIntervalMs: 5000,
        batchSize: 20,
        leaseSeconds: 60,
        timeoutMs: 10000,
        maxAttempts: 12,
      },
    });
    await assert.rejects(module.verifyConfiguration(), /Missing outbound webhook master-key versions: v1/);
  });

  it('refuses to start when a same-version master key cannot decrypt an active endpoint', async () => {
    const correctKey = Buffer.alloc(32, 3);
    const encrypted = encryptWebhookSecret('webhook-secret-that-is-at-least-32-bytes', correctKey, 'client-1', 'v1');
    const mysql = {
      query: async () => [[{
        id: 'endpoint-1',
        client_id: 'client-1',
        secret_ciphertext: encrypted.ciphertext,
        secret_iv: encrypted.iv,
        secret_auth_tag: encrypted.authTag,
        encryption_key_version: 'v1',
      }]],
    } as unknown as Pool;
    const module = createOutboundWebhooks({
      mysql,
      options: {
        enabled: true,
        masterKeys: new Map([['v1', Buffer.alloc(32, 4)]]),
        encryptionKeyVersion: 'v1',
        environment: 'production',
        pollIntervalMs: 5000,
        batchSize: 20,
        leaseSeconds: 60,
        timeoutMs: 10000,
        maxAttempts: 12,
      },
    });
    await assert.rejects(module.verifyConfiguration(), /Unable to decrypt 1 active outbound webhook endpoint secret/);
  });
});
