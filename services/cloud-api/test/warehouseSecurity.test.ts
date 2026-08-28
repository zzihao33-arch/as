import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createWarehouseSessionToken,
  hashWarehousePassword,
  normalizeWarehouseEmail,
  parseCookie,
  parseWarehouseSessionToken,
  verifyWarehousePassword,
} from '../src/warehouseSecurity.js';

describe('warehouse security primitives', () => {
  it('hashes passwords with a unique salt and verifies only the correct password', async () => {
    const first = await hashWarehousePassword('a sufficiently long password');
    const second = await hashWarehousePassword('a sufficiently long password');
    assert.notEqual(first, second);
    assert.equal(await verifyWarehousePassword('a sufficiently long password', first), true);
    assert.equal(await verifyWarehousePassword('wrong password', first), false);
  });

  it('creates opaque fixed-shape session tokens and stores only a hash', () => {
    const issued = createWarehouseSessionToken();
    assert.deepEqual(parseWarehouseSessionToken(issued.token), { keyId: issued.keyId });
    assert.equal(issued.tokenHash.length, 32);
    assert.equal(parseWarehouseSessionToken(`${issued.token}x`), null);
    assert.equal(issued.tokenHash.includes(Buffer.from(issued.token)), false);
  });

  it('normalizes email and parses an exact cookie name', () => {
    assert.equal(normalizeWarehouseEmail('  User@Example.COM '), 'user@example.com');
    assert.equal(parseCookie('other=1; cmhub_warehouse_session=abc%5F123; final=2', 'cmhub_warehouse_session'), 'abc_123');
    assert.equal(parseCookie('not_cmhub_warehouse_session=x', 'cmhub_warehouse_session'), null);
  });
});
