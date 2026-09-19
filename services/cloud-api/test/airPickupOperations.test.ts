import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Pool } from 'mysql2/promise';
import type { LabelStorage } from '../src/labelStorage.js';
import type { WarehouseSession } from '../src/warehouseIdentity.js';
import { ApiError } from '../src/errors.js';
import {
  evidenceStatusForCounts,
  createAirPickupOperations,
  normalizeAirBillNo,
  receivingValuesDiffer,
  validateAirEvidenceImage,
  validatePickupDocument,
} from '../src/airPickupOperations.js';

test('pickup list executes its paginated query and counts filtered orders before pagination', async () => {
  // Execute the portable SELECT against a real SQL engine so invalid SQL is not hidden by canned rows.
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE air_pickup_orders (
      id TEXT, receipt_batch_id TEXT, handover_batch_id TEXT, bill_no_normalized TEXT,
      cargo_name TEXT, customer_name_snapshot TEXT, client_name_snapshot TEXT, customer_profile_id TEXT,
      order_status TEXT, evidence_status TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE air_receipt_batches (id TEXT, batch_no TEXT);
      CREATE TABLE air_handover_batches (id TEXT, batch_no TEXT);
      CREATE TABLE shipments (id TEXT, air_pickup_order_id TEXT);
      CREATE TABLE print_attempts (id TEXT, shipment_id TEXT, outcome TEXT, occurred_at TEXT, created_at TEXT);
      INSERT INTO air_pickup_orders (id,bill_no_normalized,order_status,evidence_status,created_at,updated_at) VALUES
      ('one','E2E001','RECORDED','NONE','2026-09-19','2026-09-19'),
      ('two','E2E002','RECORDED','NONE','2026-09-19','2026-09-18'),
      ('three','OTHER003','VOIDED','NONE','2026-09-19','2026-09-17');`);
    const query = async (sql: string, values: SQLInputValue[] = []) => [db.prepare(sql).all(...values).map(row => ({
      ...row, ...(row.created_at ? { created_at: new Date(String(row.created_at)), updated_at: new Date(String(row.updated_at)) } : {}),
    }))];
    const service = createAirPickupOperations({ mysql: { query, execute: query } as unknown as Pool, storage: {} as LabelStorage });
    const first = await service.listOrders({ search: 'E2E', page: 1, pageSize: 1 });
    assert.deepEqual(first.orders.map(order => order.id), ['one']);
    assert.equal(first.total, 2);
    const second = await service.listOrders({ search: 'E2E', page: 2, pageSize: 1 });
    assert.deepEqual(second.orders.map(order => order.id), ['two']);
    assert.equal(second.total, 2);
    assert.deepEqual(second.summary, { recorded: 2, received: 0, handedOver: 0, voided: 1, evidencePending: 0 });
  } finally { db.close(); }
});

test('normalizes equivalent air bill numbers to one global key', () => {
  const values = ['abc-123', 'ABC-123', 'ABC123', ' abc 123 ', 'ＡBC123'.replace('Ａ', 'A')];
  assert.deepEqual(values.map(value => normalizeAirBillNo(value).normalized), Array(values.length).fill('ABC123'));
});

const legacyClientId = '00000000-0000-4000-8000-000000000201';
const upstreamCustomerId = '00000000-0000-4000-8000-000000000301';
const businessCustomerId = '00000000-0000-4000-8000-000000000302';
const otherUpstreamCustomerId = '00000000-0000-4000-8000-000000000303';
const pickupInput = { billNo: 'LEGACY-123', forecastCartons: 2, forecastPackages: 3, forecastWeight: 4, forecastWeightUnit: 'KG' };
const pickupSession = { userId: '00000000-0000-4000-8000-000000000101' } as WarehouseSession;
const pickupAudit = { requestId: 'legacy-contract-test', ip: '127.0.0.1' };

// Exercise the service's actual SQL and persisted result against a small relational
// database. Only MySQL connection plumbing and its Date conversion are adapted;
// customer lookup/filtering, inserts, transactions, and detail reads run as SQL.
function pickupContractDatabase(databaseTimeOffsetMinutes = 0) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE clients (id TEXT PRIMARY KEY, display_name TEXT, client_status TEXT);
    CREATE TABLE customer_profiles (id TEXT PRIMARY KEY, display_name TEXT, customer_type TEXT,
      customer_status TEXT, integration_client_id TEXT);
    CREATE TABLE air_pickup_orders (id TEXT PRIMARY KEY, client_id TEXT, client_name_snapshot TEXT,
      customer_profile_id TEXT, customer_name_snapshot TEXT, customer_type_snapshot TEXT, source_type TEXT,
      external_batch_id TEXT, bill_no_raw TEXT, bill_no_display TEXT, bill_no_normalized TEXT UNIQUE,
      bill_no_is_standard INTEGER, cargo_name TEXT, forecast_cartons INTEGER, forecast_packages INTEGER,
      forecast_weight REAL, forecast_weight_unit TEXT, remarks TEXT, created_by_user_id TEXT,
      created_by_reference TEXT, updated_by_user_id TEXT, updated_by_reference TEXT,
      order_status TEXT DEFAULT 'RECORDED', evidence_status TEXT DEFAULT 'NONE',
      actual_cartons INTEGER, actual_packages INTEGER, actual_weight REAL, actual_weight_unit TEXT,
      difference_reason TEXT, receipt_batch_id TEXT, handover_batch_id TEXT, received_at TEXT,
      handed_over_at TEXT, version INTEGER DEFAULT 1, void_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE air_pickup_events (revision INTEGER PRIMARY KEY, order_id TEXT, receipt_batch_id TEXT,
      handover_batch_id TEXT, event_type TEXT, actor_user_id TEXT, actor_reference TEXT, request_id TEXT,
      ip_address TEXT, reason TEXT, event_data TEXT, occurred_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE air_receipt_batches (id TEXT, batch_no TEXT);
    CREATE TABLE air_handover_batches (id TEXT, batch_no TEXT, batch_status TEXT, vehicle_no TEXT,
      driver_name TEXT, driver_phone TEXT, handed_over_at TEXT, created_by_user_id TEXT,
      created_by_reference TEXT, confirmed_by_reference TEXT, version INTEGER, confirmed_at TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE shipments (id TEXT, air_pickup_order_id TEXT);
    CREATE TABLE print_attempts (id TEXT, shipment_id TEXT, outcome TEXT, occurred_at TEXT, created_at TEXT);
    CREATE TABLE air_pickup_document_assets (id TEXT, order_id TEXT, original_filename TEXT, storage_key TEXT,
      content_sha256 TEXT, content_type TEXT, byte_size INTEGER, asset_status TEXT, uploaded_by_reference TEXT, created_at TEXT);
    CREATE TABLE air_receipt_evidence_assets (id TEXT, receipt_batch_id TEXT, original_filename TEXT, storage_key TEXT,
      content_sha256 TEXT, content_type TEXT, byte_size INTEGER, pixel_width INTEGER, pixel_height INTEGER,
      quality_warnings TEXT, quality_override INTEGER, asset_status TEXT, uploaded_by_reference TEXT, created_at TEXT);
    CREATE TABLE air_handover_evidence_assets (id TEXT, handover_batch_id TEXT, evidence_type TEXT, original_filename TEXT, storage_key TEXT,
      content_sha256 TEXT, content_type TEXT, byte_size INTEGER, pixel_width INTEGER, pixel_height INTEGER,
      quality_warnings TEXT, quality_override INTEGER, asset_status TEXT, uploaded_by_reference TEXT, created_at TEXT);
  `);
  db.prepare('INSERT INTO clients VALUES (?, ?, ?)').run(legacyClientId, 'Legacy integration', 'ACTIVE');
  db.prepare('INSERT INTO clients VALUES (?, ?, ?)').run('00000000-0000-4000-8000-000000000202', 'Other integration', 'ACTIVE');
  const insertCustomer = db.prepare('INSERT INTO customer_profiles VALUES (?, ?, ?, ?, ?)');
  insertCustomer.run(upstreamCustomerId, 'Mapped upstream customer', 'UPSTREAM', 'ACTIVE', legacyClientId);
  insertCustomer.run(businessCustomerId, 'Business customer', 'BUSINESS', 'ACTIVE', null);
  insertCustomer.run(otherUpstreamCustomerId, 'Other upstream customer', 'UPSTREAM', 'ACTIVE', '00000000-0000-4000-8000-000000000202');
  const execute = async (sql: string, values: (SQLInputValue | boolean)[] = []) => {
    const statement = db.prepare(sql.replace(/\s+FOR UPDATE\b/gi, ''));
    const parameters = values.map(value => typeof value === 'boolean' ? Number(value) : value);
    if (/^\s*SELECT\b/i.test(sql)) {
      const rows = statement.all(...parameters).map(row => {
        for (const name of ['created_at', 'updated_at', 'occurred_at', 'received_at', 'handed_over_at', 'confirmed_at']) {
          if (typeof row[name] === 'string') (row as Record<string, unknown>)[name] = new Date(`${row[name]}Z`);
        }
        return row;
      });
      return [rows];
    }
    return [{ affectedRows: Number(statement.run(...parameters).changes) }];
  };
  const connection = { execute, beginTransaction: async () => { db.exec('BEGIN'); },
    commit: async () => { db.exec('COMMIT'); }, rollback: async () => { if (db.isTransaction) db.exec('ROLLBACK'); }, release() {} };
  const mysql = { execute, query: execute, getConnection: async () => connection } as unknown as Pool;
  const timeOptions = { databaseTimeOffsetMinutes };
  const operations = createAirPickupOperations({ mysql, storage: {} as LabelStorage, ...timeOptions });
  return { db, operations };
}

test('handover, receipt evidence and pickup documents decode generated dates but preserve the supplied handover instant', async t => {
  const { db, operations } = pickupContractDatabase(480);
  t.after(() => db.close());
  const order = await operations.createOrder(pickupSession, pickupAudit, { ...pickupInput, clientId: legacyClientId });
  const batch = '00000000-0000-4000-8000-000000000501';
  const receipt = '00000000-0000-4000-8000-000000000502';
  const wallTime = '2026-09-14 23:27:16.534';
  const expected = '2026-09-14T15:27:16.534Z';
  db.prepare('INSERT INTO air_receipt_batches VALUES (?, ?)').run(receipt, 'RECEIPT-TIME-TEST');
  db.prepare('INSERT INTO air_handover_batches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(batch, 'HANDOVER-TIME-TEST', 'DRAFT', null, null, null, '2026-09-14 15:40:00.000',
      pickupSession.userId, 'test', null, 1, null, wallTime, wallTime);
  db.prepare('UPDATE air_pickup_orders SET receipt_batch_id = ?, handover_batch_id = ?, created_at = ?, updated_at = ? WHERE id = ?')
    .run(receipt, batch, wallTime, wallTime, order.id);
  db.prepare('INSERT INTO air_pickup_document_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('document', order.id, 'test.pdf', 'synthetic/document', '0'.repeat(64), 'application/pdf', 123, 'READY', 'test', wallTime);
  db.prepare('INSERT INTO air_receipt_evidence_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('receipt-image', receipt, 'test.png', 'synthetic/receipt', '0'.repeat(64), 'image/png', 123, 800, 600, null, 0, 'READY', 'test', wallTime);
  db.prepare('INSERT INTO air_handover_evidence_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('handover-image', batch, 'POD', 'test.png', 'synthetic/handover', '0'.repeat(64), 'image/png', 123, 800, 600, null, 0, 'READY', 'test', wallTime);
  const detail = await operations.getOrder(order.id);
  assert.equal(detail.receiptEvidence[0].createdAt, expected);
  assert.equal(detail.handoverEvidence[0].createdAt, expected);
  assert.equal(detail.pickupDocuments[0].createdAt, expected);
  const draft = await operations.getHandoverBatch(batch);
  assert.equal(draft.confirmedAt, null);
  db.prepare('UPDATE air_handover_batches SET confirmed_at = ?, batch_status = ? WHERE id = ?').run(wallTime, 'CONFIRMED', batch);
  const confirmed = await operations.getHandoverBatch(batch);
  assert.equal(confirmed.confirmedAt, expected);
  assert.equal(confirmed.createdAt, expected);
  assert.equal(confirmed.updatedAt, expected);
  assert.equal(confirmed.orders[0].updatedAt, expected);
  assert.equal(confirmed.evidence[0].createdAt, expected);
  assert.equal(confirmed.handedOverAt, '2026-09-14T15:40:00.000Z');
});

test('air pickup service rejects invalid injected database offsets before using the database', () => {
  for (const databaseTimeOffsetMinutes of [NaN, Infinity, 841, -841, 1.5]) {
    assert.throws(() => createAirPickupOperations({ mysql: {} as Pool, storage: {} as LabelStorage, databaseTimeOffsetMinutes }),
      /Invalid air-pickup database time offset/);
  }
});

for (const fixture of [
  { offset: 480, stored: '2026-09-14 23:27:16.534', expected: '2026-09-14T15:27:16.534Z', nyHour: '11' },
  { offset: 480, stored: '2026-01-15 00:15:00.125', expected: '2026-01-14T16:15:00.125Z', nyHour: '11' },
  { offset: 0, stored: '2026-09-14 15:27:16.534', expected: '2026-09-14T15:27:16.534Z', nyHour: '11' },
  { offset: -300, stored: '2026-09-14 10:27:16.534', expected: '2026-09-14T15:27:16.534Z', nyHour: '11' },
]) {
  test(`order list and detail decode database-generated time at offset ${fixture.offset}: ${fixture.stored}`, async t => {
    const { db, operations } = pickupContractDatabase(fixture.offset);
    t.after(() => db.close());
    const order = await operations.createOrder(pickupSession, pickupAudit, { ...pickupInput, clientId: legacyClientId });
    db.prepare('UPDATE air_pickup_orders SET created_at = ?, updated_at = ?, received_at = ?, handed_over_at = ? WHERE id = ?')
      .run(fixture.stored, fixture.stored, '2026-09-14 15:30:00.000', '2026-09-14 15:40:00.000', order.id);
    db.prepare('UPDATE air_pickup_events SET occurred_at = ?').run(fixture.stored);
    const detail = await operations.getOrder(order.id);
    const page = await operations.listOrders({ page: 1, pageSize: 20 });
    for (const result of [detail, page.orders[0]]) {
      assert.equal(result.createdAt, fixture.expected);
      assert.equal(result.updatedAt, fixture.expected);
      assert.equal(result.receivedAt, '2026-09-14T15:30:00.000Z');
      assert.equal(result.handedOverAt, '2026-09-14T15:40:00.000Z');
      assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' })
        .format(new Date(result.updatedAt)), fixture.nyHour);
    }
    assert.equal(detail.events[0].occurredAt, fixture.expected);
    assert.equal(db.prepare('SELECT updated_at FROM air_pickup_orders WHERE id = ?').get(order.id)?.updated_at, fixture.stored);
  });
}

test('legacy clientId creates a manual order belonging to the linked upstream profile, even when IDs differ', async t => {
  const { db, operations } = pickupContractDatabase();
  t.after(() => db.close());
  const order = await operations.createOrder(pickupSession, pickupAudit, { ...pickupInput, clientId: legacyClientId });
  assert.equal(order.customerId, upstreamCustomerId);
  assert.equal(order.customerName, 'Mapped upstream customer');
  assert.equal(order.customerType, 'UPSTREAM');
  assert.equal(order.sourceType, 'MANUAL');
  assert.equal(order.sourceClientId, null);
  assert.equal(order.forecastPackages, 3);
  const event = db.prepare('SELECT event_data FROM air_pickup_events').get();
  assert.equal(JSON.parse(String(event?.event_data)).customerId, upstreamCustomerId);
});

test('customerId-only requests still support business customers', async t => {
  const { db, operations } = pickupContractDatabase();
  t.after(() => db.close());
  const order = await operations.createOrder(pickupSession, pickupAudit, { ...pickupInput, customerId: businessCustomerId });
  assert.equal(order.customerId, businessCustomerId);
  assert.equal(order.customerType, 'BUSINESS');
});

test('both identifiers are accepted only when they reference the same upstream customer', async t => {
  const { db, operations } = pickupContractDatabase();
  t.after(() => db.close());
  const order = await operations.createOrder(pickupSession, pickupAudit, {
    ...pickupInput, clientId: legacyClientId, customerId: upstreamCustomerId,
  });
  assert.equal(order.customerId, upstreamCustomerId);
});

test('listOrders handles an empty list, paginates total rows, and normalizes matching search', async t => {
  const { db, operations } = pickupContractDatabase();
  t.after(() => db.close());

  const empty = await operations.listOrders({ search: '', page: 1, pageSize: 20 });
  assert.deepEqual(empty.orders, []);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.summary, { recorded: 0, received: 0, handedOver: 0, voided: 0, evidencePending: 0 });

  await operations.createOrder(pickupSession, pickupAudit, { ...pickupInput, clientId: legacyClientId });
  await operations.createOrder(pickupSession, pickupAudit, { ...pickupInput, billNo: 'BIZ-456', customerId: businessCustomerId });
  await operations.createOrder(pickupSession, pickupAudit, {
    ...pickupInput, billNo: 'OTHER-789', clientId: '00000000-0000-4000-8000-000000000202',
  });

  const secondPage = await operations.listOrders({ page: 2, pageSize: 2 });
  assert.equal(secondPage.orders.length, 1);
  assert.equal(secondPage.total, 3);
  assert.equal(secondPage.page, 2);
  assert.equal(secondPage.pageSize, 2);
  assert.equal(secondPage.summary.recorded, 3);

  const matching = await operations.listOrders({ search: 'legacy - 123', page: 1, pageSize: 20 });
  assert.equal(matching.orders.length, 1);
  assert.equal(matching.orders[0].billNo, 'LEGACY-123');
  assert.equal(matching.total, 1);
});

for (const scenario of [
  { name: 'conflicting customer and client', input: { customerId: businessCustomerId, clientId: legacyClientId } },
  { name: 'another upstream customer with the legacy client', input: { customerId: otherUpstreamCustomerId, clientId: legacyClientId } },
  { name: 'unknown legacy client', input: { clientId: '00000000-0000-4000-8000-000000000299' } },
  { name: 'profile ID passed as legacy client ID', input: { clientId: upstreamCustomerId } },
  { name: 'disabled linked customer', input: { clientId: legacyClientId }, setup: "UPDATE customer_profiles SET customer_status = 'DISABLED'" },
  { name: 'non-upstream linked customer', input: { clientId: legacyClientId }, setup: "UPDATE customer_profiles SET customer_type = 'BUSINESS'" },
  { name: 'disabled legacy integration', input: { clientId: legacyClientId }, setup: "UPDATE clients SET client_status = 'DISABLED'" },
  { name: 'missing linked profile', input: { clientId: legacyClientId }, setup: 'DELETE FROM customer_profiles' },
  { name: 'disabled explicit customer', input: { customerId: businessCustomerId }, setup: "UPDATE customer_profiles SET customer_status = 'DISABLED'" },
  { name: 'no customer identifier', input: {} },
  { name: 'explicit empty customer with valid legacy client', input: { customerId: '', clientId: legacyClientId } },
  { name: 'malformed legacy client with valid customer', input: { customerId: upstreamCustomerId, clientId: 'invalid' } },
]) {
  test(`createOrder rejects ${scenario.name} without saving an order or event`, async t => {
    const { db, operations } = pickupContractDatabase();
    t.after(() => db.close());
    if (scenario.setup) db.exec(scenario.setup);
    await assert.rejects(operations.createOrder(pickupSession, pickupAudit, { ...pickupInput, ...scenario.input }),
      (error: unknown) => error instanceof ApiError && error.status === 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM air_pickup_orders').get()?.count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM air_pickup_events').get()?.count, 0);
  });
}

test('formats a standard eleven digit air waybill', () => {
  assert.deepEqual(normalizeAirBillNo('18098109734'), {
    raw: '18098109734',
    display: '180-98109734',
    normalized: '18098109734',
    isStandard: true,
  });
});

test('accepts an abnormal alphanumeric bill with a warning flag and rejects special characters', () => {
  assert.equal(normalizeAirBillNo('AB-12-Z').isStandard, false);
  assert.throws(() => normalizeAirBillNo('180/98109734'), (error: unknown) => (
    error instanceof ApiError && error.code === 'INVALID_AIR_BILL_NO'
  ));
});

test('requires a difference reason when any actual receiving value differs', () => {
  const unchanged = receivingValuesDiffer({
    forecastCartons: 10, forecastPackages: 20, forecastWeight: 100, forecastWeightUnit: 'KG',
    actualCartons: 10, actualPackages: 20, actualWeight: 100, actualWeightUnit: 'KG',
  });
  const changed = receivingValuesDiffer({
    forecastCartons: 10, forecastPackages: 20, forecastWeight: 100, forecastWeightUnit: 'KG',
    actualCartons: 10, actualPackages: 21, actualWeight: 100, actualWeightUnit: 'KG',
  });
  assert.equal(unchanged, false);
  assert.equal(changed, true);
});

test('evidence completion requires at least one POD and three loading photos', () => {
  assert.equal(evidenceStatusForCounts(0, 0), 'NONE');
  assert.equal(evidenceStatusForCounts(1, 2), 'PARTIAL');
  assert.equal(evidenceStatusForCounts(0, 3), 'PARTIAL');
  assert.equal(evidenceStatusForCounts(1, 3), 'COMPLETE');
});

test('validates image bytes rather than trusting the file extension or header', () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(800, 16);
  png.writeUInt32BE(600, 20);
  const result = validateAirEvidenceImage(png, 'image/png');
  assert.equal(result.width, 800);
  assert.equal(result.height, 600);
  assert.equal(result.contentType, 'image/png');
  assert.throws(() => validateAirEvidenceImage(png, 'image/jpeg'), (error: unknown) => (
    error instanceof ApiError && error.code === 'EVIDENCE_CONTENT_TYPE_MISMATCH'
  ));
});

test('validates pickup-document extension, real file signature, and declared digest', () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
  const result = validatePickupDocument(pdf, 'pickup-order.pdf', 'application/pdf');
  assert.equal(result.contentType, 'application/pdf');
  assert.throws(() => validatePickupDocument(Buffer.from('not a document'), 'pickup-order.pdf'), (error: unknown) => (
    error instanceof ApiError && error.code === 'PICKUP_DOCUMENT_SIGNATURE_INVALID'
  ));
  assert.throws(() => validatePickupDocument(pdf, 'pickup-order.exe'), (error: unknown) => (
    error instanceof ApiError && error.code === 'UNSUPPORTED_PICKUP_DOCUMENT'
  ));
  assert.throws(() => validatePickupDocument(pdf, 'pickup-order.pdf', 'application/pdf', '0'.repeat(64)), (error: unknown) => (
    error instanceof ApiError && error.code === 'PICKUP_DOCUMENT_SHA256_MISMATCH'
  ));
});

test('recognizes the internal Office package path for docx and xlsx pickup documents', () => {
  const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml')]);
  const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('xl/workbook.xml')]);
  assert.equal(validatePickupDocument(docx, 'pickup.docx').contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(validatePickupDocument(xlsx, 'pickup.xlsx').contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.throws(() => validatePickupDocument(docx, 'pickup.xlsx'), (error: unknown) => (
    error instanceof ApiError && error.code === 'PICKUP_DOCUMENT_SIGNATURE_INVALID'
  ));
});
