import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Pool } from 'mysql2/promise';
import type { LabelStorage } from '../src/labelStorage.js';
import type { WarehouseSession } from '../src/warehouseIdentity.js';
import { ApiError } from '../src/errors.js';
import {
  evidenceStatusForCounts,
  normalizeAirBillNo,
  receivingValuesDiffer,
  validateAirEvidenceImage,
  validatePickupDocument,
  createAirPickupOperations,
} from '../src/airPickupOperations.js';

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
function pickupContractDatabase() {
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
    CREATE TABLE air_handover_batches (id TEXT, batch_no TEXT);
    CREATE TABLE shipments (id TEXT, air_pickup_order_id TEXT);
    CREATE TABLE print_attempts (id TEXT, shipment_id TEXT, outcome TEXT, occurred_at TEXT, created_at TEXT);
    CREATE TABLE air_pickup_document_assets (order_id TEXT, asset_status TEXT, created_at TEXT);
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
        for (const name of ['created_at', 'updated_at', 'occurred_at']) {
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
  const operations = createAirPickupOperations({ mysql, storage: {} as LabelStorage });
  return { db, operations };
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
