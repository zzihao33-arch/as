import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './errors.js';

export const WAREHOUSE_PERMISSION_CODES = [
  'dashboard.view',
  'shipments.view',
  'scan.use',
  'batches.view',
  'batches.create',
  'batches.publish',
  'batches.close',
  'batches.delete',
  'scan.import_local',
  'offline_mode.enable',
  'print.submit',
  'print.reprint',
  'print_logs.view',
  'print_logs.clear_local',
  'intercepts.view',
  'intercepts.manage',
  'air_pickups.view',
  'air_pickups.create',
  'air_pickups.edit',
  'air_pickups.receive',
  'air_pickups.handover',
  'air_pickups.evidence.add',
  'air_pickups.evidence.manage',
  'air_pickups.correct',
  'bol.view',
  'bol.manage',
  'bol.delete',
  'bol.output',
  'payroll.view',
  'payroll.manage',
  'payroll.export',
  'attendance.punch',
  'attendance.self_view',
  'attendance.appeal',
  'attendance.team_view',
  'attendance.review',
  'attendance.locations.manage',
  'attendance.rules.manage',
  'settings.printer',
  'settings.audio',
  'system_status.view',
  'callbacks.view',
  'callbacks.retry',
  'accounts.view',
  'accounts.manage',
  'accounts.reset_password',
  'roles.view',
  'roles.manage',
  'security_audit.view',
] as const;

export type WarehousePermission = typeof WAREHOUSE_PERMISSION_CODES[number];

export function hasWarehousePermission(
  permissions: readonly string[],
  required: WarehousePermission,
): boolean {
  return permissions.includes(required);
}

export function requireWarehousePermission(required: WarehousePermission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const session = req.warehouseSession;
    if (!session) {
      next(new ApiError(401, 'SESSION_REQUIRED', '请先登录仓库工作台。'));
      return;
    }
    if (session.passwordState === 'CHANGE_REQUIRED') {
      next(new ApiError(409, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码。'));
      return;
    }
    if (!hasWarehousePermission(session.permissions, required)) {
      next(new ApiError(403, 'PERMISSION_DENIED', '当前账号无权执行此操作。'));
      return;
    }
    next();
  };
}

export function requireWarehouseAnyPermission(required: readonly WarehousePermission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const session = req.warehouseSession;
    if (!session) {
      next(new ApiError(401, 'SESSION_REQUIRED', '请先登录仓库工作台。'));
      return;
    }
    if (session.passwordState === 'CHANGE_REQUIRED') {
      next(new ApiError(409, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码。'));
      return;
    }
    if (!required.some(permission => hasWarehousePermission(session.permissions, permission))) {
      next(new ApiError(403, 'PERMISSION_DENIED', '当前账号无权执行此操作。'));
      return;
    }
    next();
  };
}

export function requireWarehouseWorkspace(req: Request, _res: Response, next: NextFunction): void {
  const session = req.warehouseSession;
  if (!session) {
    next(new ApiError(401, 'SESSION_REQUIRED', '请先登录仓库工作台。'));
    return;
  }
  if (!session.warehouseId) {
    next(new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择要进入的仓库。'));
    return;
  }
  next();
}
