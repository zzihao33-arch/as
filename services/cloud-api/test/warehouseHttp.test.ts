import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../src/errors.js';
import { requireWarehouseRole } from '../src/warehouseHttp.js';
import type { WarehouseSession } from '../src/warehouseIdentity.js';

const baseSession: WarehouseSession = {
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

describe('warehouse role middleware', () => {
  it('allows a minimum operator route but rejects operator access to admin routes', () => {
    const request = { warehouseSession: baseSession } as Request;
    let operatorError: unknown;
    requireWarehouseRole('OPERATOR')(request, {} as Response, ((error?: unknown) => { operatorError = error; }) as NextFunction);
    assert.equal(operatorError, undefined);

    let adminError: unknown;
    requireWarehouseRole('ADMIN')(request, {} as Response, ((error?: unknown) => { adminError = error; }) as NextFunction);
    assert.ok(adminError instanceof ApiError);
    assert.equal(adminError.code, 'INSUFFICIENT_ROLE');
  });

  it('allows an admin through every current warehouse role boundary', () => {
    const request = { warehouseSession: { ...baseSession, role: 'ADMIN' } } as Request;
    for (const role of ['OPERATOR', 'SUPERVISOR', 'ADMIN'] as const) {
      let result: unknown;
      requireWarehouseRole(role)(request, {} as Response, ((error?: unknown) => { result = error; }) as NextFunction);
      assert.equal(result, undefined);
    }
  });
});
