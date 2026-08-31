import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../src/errors.js';
import { requireWarehouseAnyPermission, requireWarehousePermission, requireWarehouseWorkspace } from '../src/warehouseAccess.js';
import type { WarehouseSession } from '../src/warehouseIdentity.js';

const baseSession: WarehouseSession = {
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

describe('warehouse permission middleware', () => {
  it('allows an assigned permission and rejects an unassigned permission', () => {
    const request = { warehouseSession: baseSession } as unknown as Request;
    let allowedError: unknown;
    requireWarehousePermission('scan.use')(request, {} as Response, ((error?: unknown) => { allowedError = error; }) as NextFunction);
    assert.equal(allowedError, undefined);

    let deniedError: unknown;
    requireWarehousePermission('accounts.manage')(request, {} as Response, ((error?: unknown) => { deniedError = error; }) as NextFunction);
    assert.ok(deniedError instanceof ApiError);
    assert.equal(deniedError.code, 'PERMISSION_DENIED');
  });

  it('blocks normal routes until the initial password has been changed', () => {
    const request = { warehouseSession: { ...baseSession, passwordState: 'CHANGE_REQUIRED' } } as unknown as Request;
    let result: unknown;
    requireWarehousePermission('scan.use')(request, {} as Response, ((error?: unknown) => { result = error; }) as NextFunction);
    assert.ok(result instanceof ApiError);
    assert.equal(result.code, 'PASSWORD_CHANGE_REQUIRED');
  });

  it('allows a route when any one accepted permission is assigned', () => {
    const request = { warehouseSession: baseSession } as unknown as Request;
    let result: unknown;
    requireWarehouseAnyPermission(['scan.use', 'attendance.punch'])(request, {} as Response, ((error?: unknown) => { result = error; }) as NextFunction);
    assert.equal(result, undefined);

    let deniedError: unknown;
    requireWarehouseAnyPermission(['attendance.review', 'attendance.team_view'])(request, {} as Response, ((error?: unknown) => { deniedError = error; }) as NextFunction);
    assert.ok(deniedError instanceof ApiError);
    assert.equal(deniedError.code, 'PERMISSION_DENIED');
  });

  it('requires an explicitly selected warehouse for operational routes', () => {
    const request = { warehouseSession: { ...baseSession, warehouseId: null } } as unknown as Request;
    let result: unknown;
    requireWarehouseWorkspace(request, {} as Response, ((error?: unknown) => { result = error; }) as NextFunction);
    assert.ok(result instanceof ApiError);
    assert.equal(result.code, 'WAREHOUSE_SELECTION_REQUIRED');
  });
});
