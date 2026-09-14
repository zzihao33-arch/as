import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export const expiryIds = {
  shipment: '00000000-0000-4000-8000-000000000007',
  asset: '00000000-0000-4000-8000-000000000008',
};

// Execute the application's SELECTs against real relational rows. Only MySQL
// clock/locking syntax is adapted; fixed clocks reproduce a +08:00 session.
// Deployment acceptance must also execute these paths on real MySQL 8.
export function expirySqlFixture(expiresAt: string) {
  const db = new DatabaseSync(':memory:');
  db.function('utc_now', () => '2026-09-18 00:00:00.000');
  db.function('session_now', () => '2026-09-18 08:00:00.000');
  db.exec(`
    CREATE TABLE shipments (id TEXT, client_id TEXT, first_leg_tracking_no TEXT,
      courier_tracking_no TEXT, carrier TEXT, status TEXT, version INTEGER,
      updated_at TEXT, current_label_asset_id TEXT);
    CREATE TABLE label_assets (id TEXT, client_id TEXT, shipment_id TEXT,
      storage_key TEXT, asset_status TEXT, content_sha256 TEXT, byte_size INTEGER,
      expires_at TEXT, bytes_deleted_at TEXT);
    CREATE TABLE shipment_delivery_changes (revision INTEGER, shipment_id TEXT);
  `);
  db.prepare('INSERT INTO shipments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    expiryIds.shipment, 'client', 'ORIGINAL', 'TRANSFER', 'carrier', 'READY_TO_PRINT', 1,
    '2026-09-11 08:00:00.000', expiryIds.asset,
  );
  db.prepare('INSERT INTO label_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    expiryIds.asset, 'client', expiryIds.shipment, 'labels/current.pdf', 'READY', 'a'.repeat(64), 20,
    expiresAt, null,
  );
  db.prepare('INSERT INTO shipment_delivery_changes VALUES (?, ?)').run(1, expiryIds.shipment);
  return {
    close: () => db.close(),
    select(sql: string, params: unknown[] = []) {
      const compatible = sql.replace(/UTC_TIMESTAMP\(3\)/g, 'utc_now()')
        .replace(/CURRENT_TIMESTAMP\(3\)/g, 'session_now()').replace(/\s+FOR UPDATE\b/g, '');
      return db.prepare(compatible).all(...params as SQLInputValue[]);
    },
  };
}
