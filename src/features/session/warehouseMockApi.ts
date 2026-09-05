import {
  WarehouseApiError,
  type GlobalInterceptView,
  type AirHandoverBatch,
  type AirPickupDocument,
  type AirPickupOrder,
  type AirWeightUnit,
  type CustomerProfile,
  type AttendanceAppeal,
  type AttendanceDailyResult,
  type AttendanceLocation,
  type AttendancePayrollResult,
  type AttendanceShiftRule,
  type SharedWorkBatch,
  type WarehouseAccount,
  type WarehousePermissionView,
  type WarehouseRoleView,
  type WarehouseSessionView,
} from './warehouseApi';
import { deleteLocalFirstValue, readLocalFirstValue, writeLocalFirstValue } from '../../shared/storage/localFirstDatabase';
import { attendanceElapsedMinutes, attendanceWorkDate, isOpenAttendanceWithin } from '../attendance/attendanceTime';

const STORAGE_KEY = 'cmhub-dev-mock-api-v1';
const ADMIN_USER_ID = '10000000-0000-4000-8000-000000000001';
const WAREHOUSE_ID = '20000000-0000-4000-8000-000000000001';
const WORKSTATION_ID = '30000000-0000-4000-8000-000000000001';
const OPERATOR_ROLE_ID = '00000000-0000-4000-8000-000000000101';
const SUPERVISOR_ROLE_ID = '00000000-0000-4000-8000-000000000102';
const MOCK_LOGIN_NAME = 'admin';
const MOCK_PASSWORD = 'CMHub-Local-2026!';
const MOCK_CLIENT_ID = '50000000-0000-4000-8000-000000000001';

type MockBatchItem = {
  id: string;
  firstLegTrackingNo: string;
  courierTrackingNo: string | null;
  labelAssetId: string | null;
  status: 'PENDING' | 'CLAIMED' | 'SUBMITTED' | 'FAILED' | 'RESULT_UNKNOWN' | 'BLOCKED';
  claimToken: string | null;
};

type MockBatch = SharedWorkBatch & { items: MockBatchItem[] };
type MockIntercept = GlobalInterceptView & { revision: number };
type MockAirPickup = AirPickupOrder & { events: NonNullable<AirPickupOrder['events']> };

type MockState = {
  sessionActive: boolean;
  accounts: WarehouseAccount[];
  roles: WarehouseRoleView[];
  batches: MockBatch[];
  intercepts: MockIntercept[];
  interceptRevision: number;
  airPickups: MockAirPickup[];
  customers: CustomerProfile[];
  airHandoverBatches: AirHandoverBatch[];
  attendanceDaily: AttendanceDailyResult[];
  attendanceAppeals: AttendanceAppeal[];
  attendanceLocations: AttendanceLocation[];
  attendanceShiftRules: AttendanceShiftRule[];
  attendancePayProfiles: Record<string, number>;
  attendanceAdjustments: Record<string, { bonus: number; fuelDays: number }>;
};

const permissionDefinitions: WarehousePermissionView[] = [
  ['dashboard.view', 'dashboard', '查看工作概览', 'LOW'],
  ['shipments.view', 'shipments', '查看全部上游物流单据', 'MEDIUM'],
  ['scan.use', 'scan', '使用扫码匹配', 'MEDIUM'],
  ['batches.view', 'batches', '查看共享作业批次', 'LOW'],
  ['batches.create', 'batches', '创建共享作业批次', 'HIGH'],
  ['batches.publish', 'batches', '发布共享作业批次', 'HIGH'],
  ['batches.close', 'batches', '关闭共享作业批次', 'HIGH'],
  ['scan.import_local', 'scan', '使用本机应急导入', 'HIGH'],
  ['offline_mode.enable', 'scan', '启用单机应急模式', 'HIGH'],
  ['print.submit', 'print', '提交首次打印', 'MEDIUM'],
  ['print.reprint', 'print', '再次打印已处理单号', 'HIGH'],
  ['print_logs.view', 'print_logs', '查看打印审计', 'MEDIUM'],
  ['print_logs.clear_local', 'print_logs', '清理本机日志', 'MEDIUM'],
  ['intercepts.view', 'intercepts', '查看全局拦截条目', 'MEDIUM'],
  ['intercepts.manage', 'intercepts', '维护全局拦截条目', 'HIGH'],
  ['customers.view', 'customers', '查看客户档案', 'LOW'],
  ['customers.manage', 'customers', '新增和维护客户档案', 'HIGH'],
  ['air_pickups.view', 'air_pickups', '查看空运提货单', 'LOW'],
  ['air_pickups.create', 'air_pickups', '录入空运提货单', 'MEDIUM'],
  ['air_pickups.edit', 'air_pickups', '编辑已录入提单', 'MEDIUM'],
  ['air_pickups.receive', 'air_pickups', '确认提货单入库', 'MEDIUM'],
  ['air_pickups.handover', 'air_pickups', '创建并确认交仓批次', 'HIGH'],
  ['air_pickups.evidence.add', 'air_pickups', '补充交仓凭证', 'MEDIUM'],
  ['air_pickups.evidence.manage', 'air_pickups', '移除或替换交仓凭证', 'HIGH'],
  ['air_pickups.correct', 'air_pickups', '更正或作废提货单', 'HIGH'],
  ['bol.view', 'air_pickups', '查看交仓凭证', 'LOW'],
  ['bol.manage', 'air_pickups', '创建和编辑交仓凭证', 'MEDIUM'],
  ['bol.delete', 'air_pickups', '删除交仓凭证', 'HIGH'],
  ['bol.output', 'air_pickups', '输出交仓凭证', 'MEDIUM'],
  ['payroll.view', 'payroll', '查看考勤薪酬', 'HIGH'],
  ['payroll.manage', 'payroll', '维护考勤薪酬', 'HIGH'],
  ['payroll.export', 'payroll', '导出考勤薪酬', 'HIGH'],
  ['attendance.punch', 'attendance', '提交本人考勤打卡', 'MEDIUM'],
  ['attendance.self_view', 'attendance', '查看本人考勤记录', 'LOW'],
  ['attendance.appeal', 'attendance', '提交本人考勤例外申请', 'MEDIUM'],
  ['attendance.team_view', 'attendance', '查看仓库考勤记录', 'HIGH'],
  ['attendance.review', 'attendance', '审批考勤例外申请', 'HIGH'],
  ['attendance.locations.manage', 'attendance', '管理仓库打卡地点', 'HIGH'],
  ['attendance.rules.manage', 'attendance', '管理班次与薪酬规则', 'HIGH'],
  ['settings.printer', 'settings', '修改本机打印机设置', 'MEDIUM'],
  ['settings.audio', 'settings', '修改本机音效设置', 'LOW'],
  ['system_status.view', 'system_status', '查看系统状态', 'MEDIUM'],
  ['callbacks.view', 'callbacks', '查看上游回调审计', 'HIGH'],
  ['callbacks.retry', 'callbacks', '重放上游回调死信', 'HIGH'],
  ['accounts.view', 'accounts', '查看仓库账户', 'HIGH'],
  ['accounts.manage', 'accounts', '管理仓库账户', 'HIGH'],
  ['accounts.reset_password', 'accounts', '重置仓库账户密码', 'HIGH'],
  ['roles.view', 'roles', '查看角色权限', 'HIGH'],
  ['roles.manage', 'roles', '管理角色权限', 'HIGH'],
  ['security_audit.view', 'security_audit', '查看身份安全审计', 'HIGH'],
].map(([code, module, name, riskLevel]) => ({
  code: String(code),
  module: String(module),
  name: String(name),
  riskLevel: riskLevel as WarehousePermissionView['riskLevel'],
}));

const allPermissions = permissionDefinitions.map(permission => permission.code);
const operatorPermissions = ['dashboard.view', 'shipments.view', 'scan.use', 'batches.view', 'print.submit', 'print_logs.view', 'intercepts.view',
  'air_pickups.view', 'air_pickups.create', 'air_pickups.edit', 'air_pickups.receive', 'air_pickups.handover', 'air_pickups.evidence.add',
  'attendance.punch', 'attendance.self_view', 'attendance.appeal',
  'settings.printer', 'settings.audio'];
const supervisorPermissions = allPermissions.filter(permission => !permission.startsWith('accounts.') && !permission.startsWith('roles.') && permission !== 'security_audit.view' && !permission.startsWith('payroll.'));
const labelFiles = new Map<string, Blob>();
const evidenceFiles = new Map<string, Blob>();
const pickupDocumentFiles = new Map<string, Blob>();

function now() {
  return new Date().toISOString();
}

function findOpenAttendanceShift(state: MockState, timestamp: string) {
  const currentTime = new Date(timestamp);
  return state.attendanceDaily
    .filter(item => item.userId === ADMIN_USER_ID
      && item.status === 'OPEN'
      && isOpenAttendanceWithin(item.clockInAt, currentTime))
    .sort((left, right) => String(right.clockInAt).localeCompare(String(left.clockInAt)))[0] ?? null;
}

function initialState(): MockState {
  const createdAt = now();
  const membership = (roleId: string, roleName: string, employeeNo: string) => ({
    id: crypto.randomUUID(), warehouseId: WAREHOUSE_ID, warehouseCode: 'jfk-warehouse', warehouseName: 'JFK 测试仓',
    employeeNo, status: 'ACTIVE' as const, roleId, roleName,
  });
  return {
    sessionActive: true,
    roles: [
      { id: OPERATOR_ROLE_ID, code: 'OPERATOR', name: '仓库操作员', description: '扫码、首次打印和基础工作站设置', kind: 'DEFAULT', version: 1, employeeCount: 1, permissions: operatorPermissions, createdAt, updatedAt: createdAt },
      { id: SUPERVISOR_ROLE_ID, code: 'SUPERVISOR', name: '仓库主管', description: '共享批次、拦截和现场异常处理', kind: 'DEFAULT', version: 1, employeeCount: 1, permissions: supervisorPermissions, createdAt, updatedAt: createdAt },
    ],
    accounts: [
      { id: ADMIN_USER_ID, loginName: MOCK_LOGIN_NAME, displayName: '本地测试管理员', email: 'mock@cmhub.local', phone: null, status: 'ACTIVE', platformRole: 'SYSTEM_ADMIN', passwordState: 'ACTIVE', lastLoginAt: createdAt, createdAt, memberships: [] },
      { id: '10000000-0000-4000-8000-000000000002', loginName: 'operator.demo', displayName: '测试操作员', email: null, phone: null, status: 'ACTIVE', platformRole: null, passwordState: 'ACTIVE', lastLoginAt: null, createdAt, memberships: [membership(OPERATOR_ROLE_ID, '仓库操作员', 'OP-001')] },
      { id: '10000000-0000-4000-8000-000000000003', loginName: 'supervisor.demo', displayName: '测试主管', email: null, phone: null, status: 'ACTIVE', platformRole: null, passwordState: 'ACTIVE', lastLoginAt: null, createdAt, memberships: [membership(SUPERVISOR_ROLE_ID, '仓库主管', 'SP-001')] },
    ],
    batches: [],
    intercepts: [],
    interceptRevision: 0,
    airPickups: [],
    customers: [{
      id: MOCK_CLIENT_ID, code: 'MOCK-CLIENT', name: '本地测试上游客户', type: 'UPSTREAM', status: 'ACTIVE', integrationStatus: 'INTEGRATED', integrationClientId: MOCK_CLIENT_ID,
      contactName: null, contactPhone: null, contactEmail: null, createdAt, updatedAt: createdAt,
    }],
    airHandoverBatches: [],
    attendanceDaily: [],
    attendanceAppeals: [],
    attendanceLocations: [],
    attendanceShiftRules: [],
    attendancePayProfiles: {},
    attendanceAdjustments: {},
  };
}

function readState(): MockState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return initialState();
    const parsed = JSON.parse(stored) as Partial<MockState>;
    const fallback = initialState();
    const airPickups = (parsed.airPickups ?? []).map(order => ({
      ...order,
      sourceClientId: order.sourceClientId ?? MOCK_CLIENT_ID,
      sourceClientName: order.sourceClientName ?? '本地测试客户',
      customerId: order.customerId ?? MOCK_CLIENT_ID,
      customerName: order.customerName ?? order.sourceClientName ?? '本地测试上游客户',
      customerType: order.customerType ?? 'UPSTREAM' as const,
      sourceType: order.sourceType ?? 'MANUAL' as const,
      externalBatchId: order.externalBatchId ?? null,
      exchangeProgress: order.exchangeProgress ?? { total: 0, changed: 0, intercepted: 0, exceptions: 0, processed: 0, pending: 0 },
      receiptEvidence: order.receiptEvidence ?? [],
      handoverEvidence: order.handoverEvidence ?? [],
      pickupDocuments: order.pickupDocuments ?? [],
    }));
    const attendanceDaily = (parsed.attendanceDaily ?? []).map(result => {
      const normalizedWorkDate = result.clockInAt
        ? attendanceWorkDate(result.clockInAt)
        : result.workDate;
      return normalizedWorkDate && normalizedWorkDate !== result.workDate
        ? { ...result, workDate: normalizedWorkDate }
        : result;
    });
    return {
      ...fallback,
      ...parsed,
      airPickups,
      customers: parsed.customers ?? fallback.customers,
      airHandoverBatches: parsed.airHandoverBatches ?? [],
      attendanceDaily,
      attendanceAppeals: parsed.attendanceAppeals ?? [],
      attendanceLocations: parsed.attendanceLocations ?? [],
      attendanceShiftRules: parsed.attendanceShiftRules ?? [],
      attendancePayProfiles: parsed.attendancePayProfiles ?? {},
      attendanceAdjustments: parsed.attendanceAdjustments ?? {},
    };
  } catch {
    return initialState();
  }
}

function writeState(state: MockState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function sessionView(): WarehouseSessionView {
  const expiresAt = new Date(Date.now() + 8 * 60 * 60_000).toISOString();
  const absoluteExpiresAt = new Date(Date.now() + 16 * 60 * 60_000).toISOString();
  return {
    sessionId: '40000000-0000-4000-8000-000000000001', userId: ADMIN_USER_ID,
    userName: '本地测试管理员', loginName: MOCK_LOGIN_NAME, email: 'mock@cmhub.local', phone: null,
    platformRole: 'SYSTEM_ADMIN', passwordState: 'ACTIVE', warehouseId: WAREHOUSE_ID,
    warehouseCode: 'jfk-warehouse', warehouseName: 'JFK 测试仓', membershipId: null,
    roleId: null, roleName: null, permissions: allPermissions,
    workspaces: [{ warehouseId: WAREHOUSE_ID, warehouseCode: 'jfk-warehouse', warehouseName: 'JFK 测试仓', membershipId: null, roleId: null, roleName: null }],
    expiresAt, absoluteExpiresAt,
  };
}

function parseBody(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string' || !init.body) return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

function requireSession(state: MockState) {
  if (!state.sessionActive) throw new WarehouseApiError(401, 'SESSION_REQUIRED', '请先登录仓库工作台');
}

function segment(pathname: string, index: number) {
  return decodeURIComponent(pathname.split('/').filter(Boolean)[index] ?? '');
}

function normalizeAirBillNo(value: unknown) {
  const raw = String(value ?? '').trim();
  const candidate = raw.replace(/[\s\u3000]+/g, '').replace(/[－—–]/g, '-').toUpperCase();
  if (!candidate || candidate.length > 32 || !/^[A-Z0-9-]+$/.test(candidate)) {
    throw new WarehouseApiError(400, 'INVALID_AIR_BILL_NO', '提货单号仅允许字母、数字和连字符');
  }
  const normalized = candidate.replace(/-/g, '');
  const standard = /^\d{11}$/.test(normalized);
  return { raw, normalized, display: standard ? `${normalized.slice(0, 3)}-${normalized.slice(3)}` : candidate, standard };
}

function mockAirEvent(type: string, reason: string | null = null, evidence: AirPickupOrder['receiptEvidence'] = []) {
  return { revision: Date.now(), type, actorReference: `user:${ADMIN_USER_ID}`, reason, data: null, evidence, occurredAt: now() };
}

function mockEvidenceStatus(batch: AirHandoverBatch) {
  const pod = batch.evidence.filter(item => item.type === 'POD').length;
  const loading = batch.evidence.filter(item => item.type === 'LOADING').length;
  return pod >= 1 && loading >= 3 ? 'COMPLETE' as const : pod + loading > 0 ? 'PARTIAL' as const : 'NONE' as const;
}

const mockMoney = (value: number) => Math.round(value * 100) / 100;

function mockMonday(workDate: string) {
  const date = new Date(`${workDate}T12:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return date.toISOString().slice(0, 10);
}

function mockPayroll(state: MockState, from: string, to: string, persist = false): AttendancePayrollResult {
  const grouped = new Map<string, AttendanceDailyResult[]>();
  state.attendanceDaily
    .filter(row => row.workDate >= from && row.workDate <= to)
    .forEach(row => (grouped.get(row.employeeReference) ?? grouped.set(row.employeeReference, []).get(row.employeeReference)!).push(row));
  const rows = Array.from(grouped.entries()).map(([reference, days]) => {
    const weekly = new Map<string, number>();
    const issues: string[] = [];
    days.forEach(day => {
      if (day.status !== 'COMPLETE') issues.push(`${day.workDate} 考勤状态为 ${day.status}`);
      else weekly.set(mockMonday(day.workDate), (weekly.get(mockMonday(day.workDate)) ?? 0) + day.grossMinutes);
    });
    let regularMinutes = 0; let overtimeMinutes = 0;
    const weeklyMinutes = Array.from(weekly.entries()).map(([week, minutes]) => {
      regularMinutes += Math.min(2_400, minutes);
      overtimeMinutes += Math.max(0, minutes - 2_400);
      return { week, minutes };
    });
    const profile = state.attendancePayProfiles[reference] ?? null;
    const adjustment = state.attendanceAdjustments[`${reference}|${from}|${to}`] ?? { bonus: 0, fuelDays: 0 };
    if (!profile) issues.push('缺少有效基础时薪');
    const regularPay = profile ? mockMoney(regularMinutes / 60 * profile) : null;
    const overtimePay = profile ? mockMoney(overtimeMinutes / 60 * profile * 1.5) : null;
    const fuelAllowance = mockMoney(adjustment.fuelDays * 19.5);
    return {
      userId: days[0].userId,
      employeeReference: reference,
      employeeName: days[0].employeeName,
      employeeNo: days[0].employeeNo,
      hourlyRate: profile,
      bonus: adjustment.bonus,
      fuelDays: adjustment.fuelDays,
      regularMinutes,
      overtimeMinutes,
      regularPay,
      overtimePay,
      fuelAllowance,
      totalPay: regularPay === null || overtimePay === null ? null : mockMoney(regularPay + overtimePay + adjustment.bonus + fuelAllowance),
      issues,
      weeklyMinutes,
      days: days.map(day => ({ workDate: day.workDate, grossMinutes: day.grossMinutes, status: day.status })),
    };
  });
  return {
    from, to, rows, runId: persist ? crypto.randomUUID() : null,
    rule: { lunchDeductionMinutes: 0, weeklyRegularMinutes: 2_400, overtimeMultiplier: 1.5, fuelAllowancePerDay: 19.5 },
  };
}

export async function mockWarehouseRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  await new Promise(resolve => window.setTimeout(resolve, 80));
  const state = readState();
  const url = new URL(path, window.location.origin);
  const pathname = url.pathname;
  const method = (init.method ?? 'GET').toUpperCase();
  const body = parseBody(init);

  if (pathname === '/warehouse/v1/sessions' && method === 'POST') {
    if (body.loginName !== MOCK_LOGIN_NAME || body.password !== MOCK_PASSWORD) {
      throw new WarehouseApiError(401, 'INVALID_CREDENTIALS', '账号或密码错误');
    }
    state.sessionActive = true;
    writeState(state);
    return { data: sessionView() } as T;
  }
  if (pathname === '/warehouse/v1/session' && method === 'GET') {
    requireSession(state);
    return { data: sessionView() } as T;
  }
  if (pathname === '/warehouse/v1/session' && method === 'DELETE') {
    state.sessionActive = false;
    writeState(state);
    return undefined as T;
  }
  requireSession(state);
  if (pathname === '/warehouse/v1/session/renew' && method === 'POST') return { data: sessionView() } as T;
  if (pathname === '/warehouse/v1/session/workspace' && method === 'PATCH') return { data: sessionView() } as T;
  if (pathname === '/warehouse/v1/session/password' && method === 'POST') return undefined as T;
  if (pathname === '/warehouse/v1/workstations' && method === 'POST') {
    return { data: { id: WORKSTATION_ID, installationId: body.installationId, displayName: body.displayName } } as T;
  }
  if (pathname === '/warehouse/v1/shipments' && method === 'GET') return { data: [], cursor: null, hasMore: false } as T;
  if (pathname === '/warehouse/v1/print-attempts' && method === 'POST') return { data: { id: crypto.randomUUID() } } as T;
  if (pathname === '/warehouse/v1/air-pickup-clients' && method === 'GET') {
    return { data: [{ id: MOCK_CLIENT_ID, code: 'mock-client', name: '本地测试客户' }] } as T;
  }
  if (pathname === '/warehouse/v1/customers' && method === 'GET') {
    const type = url.searchParams.get('type');
    const includeDisabled = url.searchParams.get('includeDisabled') === 'true';
    return { data: state.customers.filter(customer => (!type || customer.type === type) && (includeDisabled || customer.status === 'ACTIVE')) } as T;
  }
  if (pathname === '/warehouse/v1/customers' && method === 'POST') {
    const code = String(body.customerCode ?? '').trim().toUpperCase();
    const name = String(body.name ?? '').trim();
    const type = body.type === 'UPSTREAM' ? 'UPSTREAM' : body.type === 'BUSINESS' ? 'BUSINESS' : null;
    if (!code || !name || !type) throw new WarehouseApiError(400, 'VALIDATION_ERROR', '客户名称、编码和类型为必填项');
    if (state.customers.some(customer => customer.code === code)) throw new WarehouseApiError(409, 'CUSTOMER_CODE_EXISTS', '客户编码已存在，请使用其他编码');
    const createdAt = now();
    const customer: CustomerProfile = {
      id: crypto.randomUUID(), code, name, type, status: 'ACTIVE',
      integrationStatus: type === 'UPSTREAM' ? (body.integrationStatus === 'INTEGRATING' ? 'INTEGRATING' : 'PENDING') : 'NOT_APPLICABLE',
      integrationClientId: null, contactName: body.contactName ? String(body.contactName) : null,
      contactPhone: body.contactPhone ? String(body.contactPhone) : null, contactEmail: body.contactEmail ? String(body.contactEmail) : null,
      createdAt, updatedAt: createdAt,
    };
    state.customers.push(customer); writeState(state); return { data: customer } as T;
  }
  const customerDeleteMatch = pathname.match(/^\/warehouse\/v1\/customers\/([^/]+)$/);
  if (customerDeleteMatch && method === 'DELETE') {
    const customerId = customerDeleteMatch[1];
    const customer = state.customers.find(item => item.id === customerId);
    if (!customer) throw new WarehouseApiError(404, 'CUSTOMER_NOT_FOUND', '未找到客户档案');
    if (customer.integrationClientId) throw new WarehouseApiError(409, 'CUSTOMER_INTEGRATION_CONNECTED', '已绑定系统对接的上游客户不能删除');
    if (state.airPickups.some(order => order.customerId === customerId)) throw new WarehouseApiError(409, 'CUSTOMER_IN_USE', '该客户已有提货单记录，不能删除');
    state.customers = state.customers.filter(item => item.id !== customerId);
    writeState(state);
    return undefined as T;
  }

  if (pathname === '/warehouse/v1/air-pickups' && method === 'GET') {
    const search = (url.searchParams.get('search') ?? '').replace(/[\s\u3000-]+/g, '').toUpperCase();
    const status = url.searchParams.get('status');
    const customerId = url.searchParams.get('customerId');
    const evidenceStatus = url.searchParams.get('evidenceStatus');
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const pageSize = Math.max(1, Number(url.searchParams.get('pageSize') ?? 20));
    const filtered = state.airPickups.filter(order => (!search || order.billNoNormalized.includes(search) || (order.cargoName ?? '').includes(search) || order.customerName.toUpperCase().includes(search))
      && (!customerId || order.customerId === customerId)
      && (!status || order.status === status) && (!evidenceStatus || order.evidenceStatus === evidenceStatus));
    const summary = {
      recorded: state.airPickups.filter(order => order.status === 'RECORDED').length,
      received: state.airPickups.filter(order => order.status === 'RECEIVED').length,
      handedOver: state.airPickups.filter(order => order.status === 'HANDED_OVER').length,
      voided: state.airPickups.filter(order => order.status === 'VOIDED').length,
      evidencePending: state.airPickups.filter(order => order.status === 'HANDED_OVER' && order.evidenceStatus !== 'COMPLETE').length,
    };
    return { data: filtered.slice((page - 1) * pageSize, page * pageSize), pagination: { total: filtered.length, page, pageSize }, summary } as T;
  }
  if (pathname === '/warehouse/v1/air-pickups' && method === 'POST') {
    const bill = normalizeAirBillNo(body.billNo);
    if (state.airPickups.some(order => order.billNoNormalized === bill.normalized)) {
      throw new WarehouseApiError(409, 'AIR_BILL_ALREADY_EXISTS', '该提货单号已存在；空格、大小写和连字符不影响唯一性');
    }
    const createdAt = now();
    const customer = state.customers.find(item => item.id === body.customerId && item.status === 'ACTIVE');
    if (!customer) throw new WarehouseApiError(400, 'INVALID_CUSTOMER', '请选择有效的归属客户');
    const order: MockAirPickup = {
      id: crypto.randomUUID(), sourceClientId: null, sourceClientName: customer.name, customerId: customer.id, customerName: customer.name, customerType: customer.type, sourceType: 'MANUAL', externalBatchId: null,
      billNoRaw: bill.raw, billNo: bill.display, billNoNormalized: bill.normalized,
      billNoIsStandard: bill.standard, cargoName: body.cargoName ? String(body.cargoName) : null,
      forecastCartons: Number(body.forecastCartons), forecastPackages: Number(body.forecastPackages),
      forecastWeight: Number(body.forecastWeight), forecastWeightUnit: String(body.forecastWeightUnit) as AirWeightUnit,
      remarks: body.remarks ? String(body.remarks) : null, status: 'RECORDED', evidenceStatus: 'NONE',
      actualCartons: null, actualPackages: null, actualWeight: null, actualWeightUnit: null, differenceReason: null,
      receiptBatchId: null, receiptBatchNo: null, handoverBatchId: null, handoverBatchNo: null,
      receivedAt: null, handedOverAt: null, version: 1, voidReason: null, createdAt, updatedAt: createdAt,
      exchangeProgress: { total: 0, changed: 0, intercepted: 0, exceptions: 0, processed: 0, pending: 0 },
      receiptEvidence: [], handoverEvidence: [], pickupDocuments: [],
      events: [mockAirEvent('ORDER_RECORDED')],
    };
    state.airPickups.unshift(order); writeState(state); return { data: order } as T;
  }
  if (pathname === '/warehouse/v1/air-pickup-receipt-batches' && method === 'POST') {
    const entries = Array.isArray(body.orders) ? body.orders as Array<Record<string, unknown>> : [];
    const targets = entries.map(entry => state.airPickups.find(order => order.id === entry.orderId));
    if (!entries.length || targets.some(order => !order || order.status !== 'RECORDED')) throw new WarehouseApiError(409, 'AIR_PICKUP_NOT_RECEIVABLE', '批次包含不存在或已处理的提货单，整批未保存');
    const id = crypto.randomUUID(); const receiptBatchNo = `IN-${Date.now()}`; const receivedAt = body.receivedAt ? String(body.receivedAt) : now();
    entries.forEach((entry, index) => {
      const order = targets[index]!;
      const actualCartons = Number(entry.actualCartons); const actualPackages = Number(entry.actualPackages);
      const actualWeight = Number(entry.actualWeight); const actualWeightUnit = String(entry.actualWeightUnit) as AirWeightUnit;
      const differs = actualCartons !== order.forecastCartons || actualPackages !== order.forecastPackages
        || actualWeight !== order.forecastWeight || actualWeightUnit !== order.forecastWeightUnit;
      if (differs && !entry.differenceReason) throw new WarehouseApiError(400, 'DIFFERENCE_REASON_REQUIRED', `${order.billNo} 的实际值有差异，必须填写差异说明`);
    });
    entries.forEach((entry, index) => {
      const order = targets[index]!; order.status = 'RECEIVED'; order.actualCartons = Number(entry.actualCartons);
      order.actualPackages = Number(entry.actualPackages); order.actualWeight = Number(entry.actualWeight);
      order.actualWeightUnit = String(entry.actualWeightUnit) as AirWeightUnit;
      order.differenceReason = entry.differenceReason ? String(entry.differenceReason) : null;
      order.receiptBatchId = id; order.receiptBatchNo = receiptBatchNo; order.receivedAt = receivedAt;
      order.version += 1; order.updatedAt = now(); order.events.unshift(mockAirEvent('ORDER_RECEIVED', order.differenceReason));
    });
    writeState(state); return { data: { id, batchNo: receiptBatchNo, receivedAt, orderCount: entries.length } } as T;
  }
  if (pathname === '/warehouse/v1/air-handover-batches' && method === 'POST') {
    const orderIds = Array.isArray(body.orderIds) ? body.orderIds.map(String) : [];
    const targets = orderIds.map(id => state.airPickups.find(order => order.id === id));
    if (!orderIds.length || targets.some(order => !order || order.status !== 'RECEIVED' || order.handoverBatchId)) throw new WarehouseApiError(409, 'AIR_PICKUP_NOT_HANDOVER_READY', '批次包含未入库或已加入其他交仓批次的提货单');
    const createdAt = now();
    const batch: AirHandoverBatch = { id: crypto.randomUUID(), batchNo: `HO-${Date.now()}`, status: 'DRAFT',
      vehicleNo: body.vehicleNo ? String(body.vehicleNo) : null, driverName: body.driverName ? String(body.driverName) : null,
      driverPhone: body.driverPhone ? String(body.driverPhone) : null, handedOverAt: body.handedOverAt ? String(body.handedOverAt) : createdAt,
      createdByUserId: ADMIN_USER_ID, version: 1, confirmedAt: null, createdAt, updatedAt: createdAt,
      orders: targets as AirPickupOrder[], evidence: [] };
    targets.forEach(order => { order!.handoverBatchId = batch.id; order!.handoverBatchNo = batch.batchNo; order!.version += 1; order!.events.unshift(mockAirEvent('HANDOVER_DRAFT_CREATED')); });
    state.airHandoverBatches.unshift(batch); writeState(state); return { data: batch } as T;
  }
  if (pathname.startsWith('/warehouse/v1/air-handover-batches/')) {
    const batchId = segment(pathname, 3);
    const batch = state.airHandoverBatches.find(item => item.id === batchId);
    if (!batch) throw new WarehouseApiError(404, 'HANDOVER_BATCH_NOT_FOUND', '未找到交仓批次');
    batch.orders = state.airPickups.filter(order => order.handoverBatchId === batch.id);
    if (pathname.endsWith('/confirm') && method === 'POST') {
      if (batch.status !== 'DRAFT') throw new WarehouseApiError(409, 'HANDOVER_ALREADY_CONFIRMED', '该交仓批次已经确认');
      const evidenceStatus = mockEvidenceStatus(batch); batch.status = 'CONFIRMED'; batch.confirmedAt = now(); batch.version += 1;
      batch.orders.forEach(order => {
        order.status = 'HANDED_OVER'; order.handedOverAt = batch.handedOverAt; order.evidenceStatus = evidenceStatus;
        order.handoverEvidence = [...batch.evidence]; order.version += 1; order.updatedAt = now();
        order.events?.unshift(mockAirEvent('ORDER_HANDED_OVER', null, batch.evidence));
      });
      writeState(state); return { data: batch } as T;
    }
    if (method === 'PATCH') {
      if (Number(body.expectedVersion) !== batch.version) throw new WarehouseApiError(409, 'HANDOVER_VERSION_CONFLICT', '交仓批次已被其他人修改，请刷新');
      const orderIds = Array.isArray(body.orderIds) ? body.orderIds.map(String) : [];
      const targets = orderIds.map(id => state.airPickups.find(order => order.id === id));
      if (!orderIds.length || targets.some(order => !order || (order!.handoverBatchId !== batch.id && (order!.status !== 'RECEIVED' || order!.handoverBatchId)))) {
        throw new WarehouseApiError(409, 'AIR_PICKUP_NOT_HANDOVER_READY', '成员变更包含未入库或已加入其他交仓批次的提货单');
      }
      state.airPickups.filter(order => order.handoverBatchId === batch.id && !orderIds.includes(order.id)).forEach(order => {
        order.handoverBatchId = null; order.handoverBatchNo = null; order.handedOverAt = null; order.status = 'RECEIVED';
        order.evidenceStatus = 'NONE'; order.version += 1; order.updatedAt = now(); order.events.unshift(mockAirEvent('ORDER_CORRECTED', body.reason ? String(body.reason) : null));
      });
      const evidenceStatus = mockEvidenceStatus(batch);
      targets.forEach(order => {
        order!.handoverBatchId = batch.id; order!.handoverBatchNo = batch.batchNo;
        if (batch.status === 'CONFIRMED') { order!.status = 'HANDED_OVER'; order!.handedOverAt = String(body.handedOverAt); order!.evidenceStatus = evidenceStatus; }
        order!.version += 1; order!.updatedAt = now(); order!.events.unshift(mockAirEvent(batch.status === 'CONFIRMED' ? 'ORDER_CORRECTED' : 'HANDOVER_DRAFT_CREATED', body.reason ? String(body.reason) : null));
      });
      batch.vehicleNo = body.vehicleNo ? String(body.vehicleNo) : null; batch.driverName = body.driverName ? String(body.driverName) : null;
      batch.driverPhone = body.driverPhone ? String(body.driverPhone) : null; batch.handedOverAt = String(body.handedOverAt);
      batch.version += 1; batch.updatedAt = now(); batch.orders = targets as AirPickupOrder[]; writeState(state); return { data: batch } as T;
    }
    if (method === 'GET') return { data: batch } as T;
  }
  if (pathname.startsWith('/warehouse/v1/air-pickups/')) {
    const orderId = segment(pathname, 3);
    const order = state.airPickups.find(item => item.id === orderId);
    if (!order) throw new WarehouseApiError(404, 'AIR_PICKUP_NOT_FOUND', '未找到空运提货单');
    if (pathname.endsWith('/void') && method === 'POST') {
      order.status = 'VOIDED'; order.voidReason = String(body.reason ?? ''); order.version += 1; order.updatedAt = now(); order.events.unshift(mockAirEvent('ORDER_VOIDED', order.voidReason)); writeState(state); return undefined as T;
    }
    if (method === 'PATCH') {
      if (order.status !== 'RECORDED' || order.version !== Number(body.expectedVersion)) throw new WarehouseApiError(409, 'AIR_PICKUP_VERSION_CONFLICT', '提货单已被修改，请刷新');
      Object.assign(order, { cargoName: body.cargoName ? String(body.cargoName) : null, forecastCartons: Number(body.forecastCartons),
        forecastPackages: Number(body.forecastPackages), forecastWeight: Number(body.forecastWeight),
        forecastWeightUnit: String(body.forecastWeightUnit), remarks: body.remarks ? String(body.remarks) : null });
      order.version += 1; order.updatedAt = now(); order.events.unshift(mockAirEvent('ORDER_EDITED')); writeState(state); return { data: order } as T;
    }
    if (method === 'GET') return { data: order } as T;
  }
  if (pathname.startsWith('/warehouse/v1/air-evidence-assets/') && method === 'DELETE') {
    const assetId = segment(pathname, 3);
    const batch = state.airHandoverBatches.find(item => item.evidence.some(asset => asset.id === assetId));
    if (!batch) throw new WarehouseApiError(404, 'EVIDENCE_NOT_FOUND', '凭证不存在或已移除');
    batch.evidence = batch.evidence.filter(asset => asset.id !== assetId);
    evidenceFiles.delete(assetId);
    await deleteLocalFirstValue('airEvidence', assetId).catch(() => undefined);
    const evidenceStatus = mockEvidenceStatus(batch);
    state.airPickups.filter(order => order.handoverBatchId === batch.id).forEach(order => {
      order.evidenceStatus = evidenceStatus; order.version += 1; order.updatedAt = now();
      order.events.unshift(mockAirEvent('EVIDENCE_REMOVED', String(body.reason ?? '')));
    });
    writeState(state); return { data: { evidenceStatus } } as T;
  }
  if (pathname.startsWith('/warehouse/v1/air-pickup-documents/') && method === 'DELETE') {
    const assetId = segment(pathname, 3);
    const order = state.airPickups.find(item => item.pickupDocuments?.some(document => document.id === assetId));
    if (!order) throw new WarehouseApiError(404, 'PICKUP_DOCUMENT_NOT_FOUND', '提货文件不存在或已移除');
    order.pickupDocuments = order.pickupDocuments?.filter(document => document.id !== assetId) ?? [];
    pickupDocumentFiles.delete(assetId);
    await deleteLocalFirstValue('airPickupDocuments', assetId).catch(() => undefined);
    order.updatedAt = now(); order.version += 1; order.events.unshift(mockAirEvent('PICKUP_DOCUMENT_REMOVED', String(body.reason ?? '')));
    writeState(state); return undefined as T;
  }

  if (pathname === '/warehouse/v1/attendance/context' && method === 'GET') {
    const timestamp = now();
    const today = attendanceWorkDate(timestamp);
    const todayResult = state.attendanceDaily.find(item => item.userId === ADMIN_USER_ID && item.workDate === today) ?? null;
    const openShift = findOpenAttendanceShift(state, timestamp);
    return { data: {
      employeeName: '本地测试管理员', employeeNo: 'ADMIN-001', today,
      locations: state.attendanceLocations.filter(item => item.status === 'ACTIVE'),
      shiftRule: state.attendanceShiftRules.find(item => item.status === 'ACTIVE') ?? null,
      todayResult: openShift ?? todayResult,
      serverTime: timestamp,
    } } as T;
  }

  if (pathname === '/warehouse/v1/attendance/daily-results' && method === 'GET') {
    const dateFrom = url.searchParams.get('dateFrom') ?? '2000-01-01';
    const dateTo = url.searchParams.get('dateTo') ?? '2099-12-31';
    return { data: { from: dateFrom, to: dateTo,
      rows: state.attendanceDaily.filter(item => item.workDate >= dateFrom && item.workDate <= dateTo)
        .sort((a, b) => b.workDate.localeCompare(a.workDate)) } } as T;
  }

  if (pathname === '/warehouse/v1/attendance/appeals' && method === 'GET') {
    const status = url.searchParams.get('status');
    return { data: state.attendanceAppeals.filter(item => !status || item.status === status) } as T;
  }

  if (pathname === '/warehouse/v1/attendance/appeals' && method === 'POST') {
    const createdAt = now();
    const appeal: AttendanceAppeal = {
      id: crypto.randomUUID(), userId: ADMIN_USER_ID, employeeReference: `user:${ADMIN_USER_ID}`,
      employeeName: '本地测试管理员', employeeNo: 'ADMIN-001', workDate: String(body.workDate),
      type: body.type as AttendanceAppeal['type'], requestedClockInAt: String(body.requestedClockInAt || '') || null,
      requestedClockOutAt: String(body.requestedClockOutAt || '') || null, description: String(body.description),
      status: 'PENDING', reviewNote: null, reviewedByReference: null, reviewedAt: null,
      expiresAt: new Date(Date.now() + 72 * 60 * 60_000).toISOString(), createdAt, updatedAt: createdAt,
    };
    state.attendanceAppeals.unshift(appeal); writeState(state);
    return { data: appeal } as T;
  }

  if (pathname.startsWith('/warehouse/v1/attendance/appeals/') && pathname.endsWith('/review') && method === 'PATCH') {
    const appeal = state.attendanceAppeals.find(item => item.id === segment(pathname, 4));
    if (!appeal) throw new WarehouseApiError(404, 'APPEAL_NOT_FOUND', '未找到申诉');
    appeal.status = body.decision as AttendanceAppeal['status']; appeal.reviewNote = String(body.reviewNote || '') || null;
    appeal.reviewedByReference = `user:${ADMIN_USER_ID}`; appeal.reviewedAt = now(); appeal.updatedAt = now(); writeState(state);
    return { data: appeal } as T;
  }

  if (pathname === '/warehouse/v1/attendance/locations' && method === 'GET') return { data: state.attendanceLocations } as T;
  if (pathname === '/warehouse/v1/attendance/locations' && method === 'PUT') {
    const existing = state.attendanceLocations.find(item => item.id === body.id);
    const timestamp = now();
    const location: AttendanceLocation = {
      id: existing?.id ?? crypto.randomUUID(), name: String(body.name), address: String(body.address || '') || null,
      latitude: Number(body.latitude), longitude: Number(body.longitude), radiusMeters: Number(body.radiusMeters),
      status: body.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE', createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
    };
    if (existing) Object.assign(existing, location); else state.attendanceLocations.push(location); writeState(state);
    return { data: location } as T;
  }

  if (pathname === '/warehouse/v1/attendance/shift-rules' && method === 'GET') return { data: state.attendanceShiftRules } as T;
  if (pathname === '/warehouse/v1/attendance/shift-rules' && method === 'PUT') {
    const existing = state.attendanceShiftRules.find(item => item.id === body.id);
    const rule: AttendanceShiftRule = {
      id: existing?.id ?? crypto.randomUUID(), name: String(body.name), timeZone: 'America/New_York',
      weekdays: body.weekdays as number[], startTime: String(body.startTime), endTime: String(body.endTime),
      lateGraceMinutes: Number(body.lateGraceMinutes), earlyGraceMinutes: Number(body.earlyGraceMinutes),
      effectiveFrom: String(body.effectiveFrom), effectiveTo: String(body.effectiveTo || '') || null,
      status: body.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE', version: (existing?.version ?? 0) + 1,
    };
    if (existing) Object.assign(existing, rule); else state.attendanceShiftRules.push(rule); writeState(state);
    return { data: rule } as T;
  }

  if (pathname === '/warehouse/v1/attendance/payroll-preview' && method === 'GET') {
    const dateFrom = url.searchParams.get('dateFrom') ?? new Date().toISOString().slice(0, 8) + '01';
    const dateTo = url.searchParams.get('dateTo') ?? new Date().toISOString().slice(0, 10);
    return { data: mockPayroll(state, dateFrom, dateTo) } as T;
  }
  if (pathname === '/warehouse/v1/attendance/payroll-runs' && method === 'POST') {
    return { data: mockPayroll(state, String(body.dateFrom), String(body.dateTo), true) } as T;
  }
  if (pathname === '/warehouse/v1/attendance/pay-profiles' && method === 'PUT') {
    state.attendancePayProfiles[`user:${String(body.userId)}`] = Number(body.hourlyRate); writeState(state);
    return { data: body } as T;
  }
  if (pathname === '/warehouse/v1/attendance/payroll-adjustments' && method === 'PUT') {
    state.attendanceAdjustments[`${String(body.employeeReference)}|${String(body.periodStart)}|${String(body.periodEnd)}`] = {
      bonus: Number(body.bonus), fuelDays: Number(body.fuelDays),
    }; writeState(state); return { data: body } as T;
  }

  if (pathname === '/warehouse/v1/accounts' && method === 'GET') {
    const search = (url.searchParams.get('search') ?? '').toLowerCase();
    const status = url.searchParams.get('status');
    const roleId = url.searchParams.get('roleId');
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const pageSize = Math.max(1, Number(url.searchParams.get('pageSize') ?? 20));
    const filtered = state.accounts.filter(account => (!search || [account.loginName, account.displayName, account.phone ?? '', ...account.memberships.map(item => item.employeeNo ?? '')].some(value => value.toLowerCase().includes(search)))
      && (!status || account.status === status)
      && (!roleId || account.memberships.some(item => item.roleId === roleId)));
    return { data: filtered.slice((page - 1) * pageSize, page * pageSize), pagination: { total: filtered.length, page, pageSize } } as T;
  }
  if (pathname === '/warehouse/v1/accounts' && method === 'POST') {
    const role = state.roles.find(item => item.id === body.roleId);
    if (!role) throw new WarehouseApiError(400, 'INVALID_ACCOUNT_ASSIGNMENT', '请选择有效角色');
    const id = crypto.randomUUID();
    const account: WarehouseAccount = {
      id, loginName: String(body.loginName), displayName: String(body.displayName), email: body.email ? String(body.email) : null,
      phone: body.phone ? String(body.phone) : null, status: 'ACTIVE', platformRole: null, passwordState: 'CHANGE_REQUIRED',
      lastLoginAt: null, createdAt: now(), memberships: [{ id: crypto.randomUUID(), warehouseId: WAREHOUSE_ID,
        warehouseCode: 'jfk-warehouse', warehouseName: 'JFK 测试仓', employeeNo: body.employeeNo ? String(body.employeeNo) : null,
        status: 'ACTIVE', roleId: role.id, roleName: role.name }],
    };
    state.accounts.unshift(account);
    role.employeeCount += 1;
    writeState(state);
    return { data: { id, loginName: account.loginName, displayName: account.displayName, temporaryPassword: 'Mock-Temporary-2026!' } } as T;
  }
  if (pathname.startsWith('/warehouse/v1/accounts/')) {
    const accountId = segment(pathname, 3);
    const account = state.accounts.find(item => item.id === accountId);
    if (!account) throw new WarehouseApiError(404, 'ACCOUNT_NOT_FOUND', '未找到账户');
    if (pathname.endsWith('/role') && method === 'PUT') {
      const role = state.roles.find(item => item.id === body.roleId);
      if (!role) throw new WarehouseApiError(404, 'ROLE_NOT_FOUND', '未找到角色');
      account.memberships = [{ id: account.memberships[0]?.id ?? crypto.randomUUID(), warehouseId: WAREHOUSE_ID,
        warehouseCode: 'jfk-warehouse', warehouseName: 'JFK 测试仓', employeeNo: body.employeeNo ? String(body.employeeNo) : null,
        status: 'ACTIVE', roleId: role.id, roleName: role.name }];
      writeState(state);
      return { data: { id: account.id } } as T;
    }
    if (pathname.endsWith('/reset-password') && method === 'POST') {
      account.passwordState = 'CHANGE_REQUIRED';
      writeState(state);
      return { data: { id: account.id, temporaryPassword: 'Mock-Temporary-2026!' } } as T;
    }
    if (method === 'PATCH') {
      Object.assign(account, Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)));
      writeState(state);
      return { data: { id: account.id } } as T;
    }
    if (method === 'DELETE') {
      state.accounts = state.accounts.filter(item => item.id !== account.id);
      writeState(state);
      return undefined as T;
    }
  }
  if (pathname.startsWith('/warehouse/v1/login-locks/') && pathname.endsWith('/unlock') && method === 'POST') return undefined as T;

  if (pathname === '/warehouse/v1/permissions' && method === 'GET') return { data: permissionDefinitions } as T;
  if (pathname === '/warehouse/v1/roles' && method === 'GET') return { data: state.roles } as T;
  if (pathname === '/warehouse/v1/roles' && method === 'POST') {
    const role: WarehouseRoleView = { id: crypto.randomUUID(), code: `CUSTOM_${Date.now()}`, name: String(body.name),
      description: body.description ? String(body.description) : null, kind: 'CUSTOM', version: 1, employeeCount: 0,
      permissions: [], createdAt: now(), updatedAt: now() };
    state.roles.push(role);
    writeState(state);
    return { data: role } as T;
  }
  if (pathname.startsWith('/warehouse/v1/roles/')) {
    const roleId = segment(pathname, 3);
    const role = state.roles.find(item => item.id === roleId);
    if (!role) throw new WarehouseApiError(404, 'ROLE_NOT_FOUND', '未找到角色');
    if (method === 'PATCH') {
      if (Number(body.expectedVersion) !== role.version) throw new WarehouseApiError(409, 'ROLE_VERSION_CONFLICT', '角色已被修改，请刷新');
      if (body.name) role.name = String(body.name);
      if (body.description !== undefined) role.description = body.description ? String(body.description) : null;
      if (Array.isArray(body.permissions)) role.permissions = body.permissions.map(String);
      role.version += 1;
      role.updatedAt = now();
      writeState(state);
      return { data: { id: role.id } } as T;
    }
    if (method === 'DELETE') {
      state.roles = state.roles.filter(item => item.id !== role.id);
      state.accounts.forEach(account => account.memberships.forEach(membership => {
        if (membership.roleId === role.id) { membership.roleId = null; membership.roleName = null; }
      }));
      writeState(state);
      return undefined as T;
    }
  }

  if (pathname === '/warehouse/v1/work-batches' && method === 'GET') {
    const status = url.searchParams.get('status');
    return { data: state.batches.filter(batch => !status || batch.status === status).map(({ items: _items, ...batch }) => batch) } as T;
  }
  if (pathname === '/warehouse/v1/work-batches' && method === 'POST') {
    const batch: MockBatch = { id: crypto.randomUUID(), name: String(body.name), status: 'DRAFT', mappingCount: 0, pdfCount: 0,
      version: 1, publishedAt: null, closedAt: null, createdAt: now(), updatedAt: now(), items: [] };
    state.batches.unshift(batch);
    writeState(state);
    return { data: batch } as T;
  }
  if (pathname.startsWith('/warehouse/v1/work-batches/')) {
    const batchId = segment(pathname, 3);
    const batch = state.batches.find(item => item.id === batchId);
    if (!batch) throw new WarehouseApiError(404, 'BATCH_NOT_FOUND', '未找到共享批次');
    if (pathname.endsWith('/missing-items') && method === 'GET') {
      const missingItems = batch.items.filter(item => !item.labelAssetId);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 500);
      return { data: {
        total: missingItems.length,
        items: missingItems.slice(offset, offset + limit).map(item => ({
          firstLegTrackingNo: item.firstLegTrackingNo,
          courierTrackingNo: item.courierTrackingNo,
          reason: '未匹配面单',
          updatedAt: batch.updatedAt,
        })),
      } } as T;
    }
    if (pathname.endsWith('/items') && method === 'POST') {
      if (batch.status !== 'DRAFT') throw new WarehouseApiError(409, 'BATCH_NOT_EDITABLE', '只有草稿批次可以继续导入');
      const items = Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : [];
      items.forEach(item => {
        const firstLeg = String(item.firstLegTrackingNo).toUpperCase();
        const existing = batch.items.find(candidate => candidate.firstLegTrackingNo === firstLeg);
        if (existing) existing.courierTrackingNo = item.courierTrackingNo ? String(item.courierTrackingNo).toUpperCase() : null;
        else batch.items.push({ id: crypto.randomUUID(), firstLegTrackingNo: firstLeg,
          courierTrackingNo: item.courierTrackingNo ? String(item.courierTrackingNo).toUpperCase() : null,
          labelAssetId: null, status: 'PENDING', claimToken: null });
      });
      batch.mappingCount = batch.items.length;
      batch.updatedAt = now();
      writeState(state);
      return { data: { importedCount: items.length } } as T;
    }
    if (pathname.endsWith('/publish') && method === 'POST') {
      if (batch.mappingCount < 1) throw new WarehouseApiError(409, 'BATCH_INCOMPLETE', '至少需要一条 Excel 映射');
      batch.status = 'ACTIVE'; batch.publishedAt = now(); batch.version += 1; writeState(state);
      return { data: batch } as T;
    }
    if (pathname.endsWith('/close') && method === 'POST') {
      batch.status = 'CLOSED'; batch.closedAt = now(); batch.version += 1; writeState(state);
      return { data: batch } as T;
    }
  }
  if (pathname === '/warehouse/v1/work-batch-claims' && method === 'POST') {
    const trackingNo = String(body.trackingNo).replaceAll(/\s+/g, '').toUpperCase();
    const blocked = state.intercepts.find(item => item.status === 'ACTIVE' && item.trackingNo === trackingNo);
    if (blocked) return { data: { blocked: true, trackingNo, reason: blocked.reason } } as T;
    const matches = state.batches.filter(batch => batch.status === 'ACTIVE').flatMap(batch => batch.items
      .filter(item => item.firstLegTrackingNo === trackingNo || item.courierTrackingNo === trackingNo)
      .map(item => ({ batch, item })));
    if (matches.length === 0) throw new WarehouseApiError(404, 'BATCH_ITEM_NOT_FOUND', '当前生效批次中未找到该单号');
    if (matches.length > 1) throw new WarehouseApiError(409, 'AMBIGUOUS_BATCH_ITEM', '该单号同时存在于多个活动批次');
    const { batch, item } = matches[0];
    const mappedBlocked = state.intercepts.find(intercept => intercept.status === 'ACTIVE'
      && [item.firstLegTrackingNo, item.courierTrackingNo].includes(intercept.trackingNo));
    if (mappedBlocked) return { data: { blocked: true, trackingNo: mappedBlocked.trackingNo, reason: mappedBlocked.reason } } as T;
    if (!item.labelAssetId) throw new WarehouseApiError(409, 'LABEL_NOT_READY', '该单号尚无可用面单');
    item.claimToken = crypto.randomUUID(); item.status = 'CLAIMED'; writeState(state);
    return { data: { blocked: false, claimToken: item.claimToken, item: { id: item.id, batchId: batch.id, batchName: batch.name,
      firstLegTrackingNo: item.firstLegTrackingNo, courierTrackingNo: item.courierTrackingNo, labelAssetId: item.labelAssetId,
      labelDownloadPath: `/warehouse/v1/shared-label-assets/${item.labelAssetId}/content`, labelSha256: '0'.repeat(64), labelByteSize: 64 } } } as T;
  }
  if (pathname.startsWith('/warehouse/v1/work-batch-items/') && pathname.endsWith('/complete') && method === 'POST') {
    const itemId = segment(pathname, 3);
    const item = state.batches.flatMap(batch => batch.items).find(candidate => candidate.id === itemId);
    if (!item) throw new WarehouseApiError(404, 'BATCH_ITEM_NOT_FOUND', '未找到批次单号');
    item.status = String(body.outcome) as MockBatchItem['status'];
    writeState(state);
    return { data: { id: crypto.randomUUID(), outcome: item.status } } as T;
  }

  if (pathname === '/warehouse/v1/intercepts' && method === 'GET') {
    const cursor = Number(url.searchParams.get('cursor') ?? 0);
    const entries = state.intercepts.filter(item => item.revision > cursor).map(({ revision: _revision, ...entry }) => entry);
    return { data: entries, cursor: String(state.interceptRevision), hasMore: false } as T;
  }
  if (pathname === '/warehouse/v1/intercepts/check' && method === 'POST') {
    const numbers = Array.isArray(body.trackingNumbers) ? body.trackingNumbers.map(value => String(value).replaceAll(/\s+/g, '').toUpperCase()) : [];
    const intercept = state.intercepts.find(item => item.status === 'ACTIVE' && numbers.includes(item.trackingNo));
    return { data: intercept ? { blocked: true, trackingNo: intercept.trackingNo, reason: intercept.reason } : { blocked: false } } as T;
  }
  if (pathname === '/warehouse/v1/intercepts' && method === 'POST') {
    const entries = Array.isArray(body.entries) ? body.entries as Array<Record<string, unknown>> : [];
    entries.forEach(entry => {
      const trackingNo = String(entry.trackingNo).replaceAll(/\s+/g, '').toUpperCase();
      state.interceptRevision += 1;
      const existing = state.intercepts.find(item => item.trackingNo === trackingNo);
      if (existing) Object.assign(existing, { reason: entry.reason ? String(entry.reason) : null, status: 'ACTIVE', updatedAt: now(), revision: state.interceptRevision });
      else state.intercepts.push({ id: crypto.randomUUID(), trackingNo, reason: entry.reason ? String(entry.reason) : null,
        source: body.source === 'BULK_IMPORT' ? 'BULK_IMPORT' : 'MANUAL', status: 'ACTIVE', updatedAt: now(), revision: state.interceptRevision });
    });
    writeState(state);
    return { data: { importedCount: entries.length } } as T;
  }
  if (pathname.startsWith('/warehouse/v1/intercepts/') && method === 'DELETE') {
    const trackingNo = segment(pathname, 3).toUpperCase();
    const intercept = state.intercepts.find(item => item.trackingNo === trackingNo);
    if (!intercept) throw new WarehouseApiError(404, 'INTERCEPT_NOT_FOUND', '未找到拦截单号');
    state.interceptRevision += 1; intercept.status = 'REMOVED'; intercept.revision = state.interceptRevision; intercept.updatedAt = now();
    writeState(state);
    return undefined as T;
  }
  if (pathname === '/warehouse/v1/security-audit' && method === 'GET') return { data: [] } as T;
  if (pathname === '/warehouse/v1/outbound-events' && method === 'GET') return { data: [] } as T;

  throw new WarehouseApiError(404, 'MOCK_ROUTE_NOT_FOUND', `本地 Mock 尚未实现：${method} ${pathname}`);
}

export async function mockSubmitAttendancePunch(input: {
  photo: Blob; punchType: 'IN' | 'OUT'; channel: 'MOBILE' | 'WORKSTATION'; workstationId?: string;
  gestureType: 'BLINK' | 'MOUTH_OPEN'; gesturePassed: boolean; gestureScore: number; clientCapturedAt: string;
  latitude?: number; longitude?: number; accuracy?: number;
}) {
  await new Promise(resolve => window.setTimeout(resolve, 180));
  const state = readState();
  const timestamp = now();
  const today = attendanceWorkDate(timestamp);
  const existing = state.attendanceDaily.find(item => item.userId === ADMIN_USER_ID && item.workDate === today);
  const openShift = findOpenAttendanceShift(state, timestamp);
  if (!input.gesturePassed || input.gestureScore < 0.005) {
    return { data: { attemptId: crypto.randomUUID(), accepted: false, result: 'EXCEPTION_REQUIRED',
      reasonCode: 'GESTURE_NOT_VERIFIED', message: '动作验证未通过，请重试或提交例外申请', serverTime: timestamp } };
  }
  if (input.channel === 'MOBILE' && (input.latitude === undefined || input.accuracy === undefined || input.accuracy > 50)) {
    return { data: { attemptId: crypto.randomUUID(), accepted: false, result: 'EXCEPTION_REQUIRED',
      reasonCode: 'LOCATION_REQUIRED', message: '手机打卡需要有效的浏览器位置', serverTime: timestamp } };
  }
  if (input.punchType === 'IN' && openShift) {
    return { data: { attemptId: crypto.randomUUID(), accepted: false, result: 'REJECTED',
      reasonCode: 'OPEN_SHIFT_EXISTS', message: '仍有18小时内的上班记录，请先完成下班打卡', serverTime: timestamp } };
  }
  if (input.punchType === 'IN' && existing) {
    return { data: { attemptId: crypto.randomUUID(), accepted: false, result: 'REJECTED',
      reasonCode: 'CLOCK_IN_ALREADY_EXISTS', message: '今天已经存在上班打卡', serverTime: timestamp } };
  }
  if (input.punchType === 'OUT' && !openShift) {
    return { data: { attemptId: crypto.randomUUID(), accepted: false, result: 'EXCEPTION_REQUIRED',
      reasonCode: 'OPEN_SHIFT_NOT_FOUND', message: '未找到18小时内的上班打卡', serverTime: timestamp } };
  }
  let daily: AttendanceDailyResult;
  if (input.punchType === 'IN') {
    daily = {
      id: crypto.randomUUID(), userId: ADMIN_USER_ID, employeeReference: `user:${ADMIN_USER_ID}`,
      employeeName: '本地测试管理员', employeeNo: 'ADMIN-001', workDate: today,
      clockInAt: timestamp, clockOutAt: null, grossMinutes: 0, netMinutes: 0, status: 'OPEN',
      isLate: false, isEarlyLeave: false, version: 1, updatedAt: timestamp,
    };
    state.attendanceDaily.push(daily);
  } else {
    daily = openShift!;
    const grossMinutes = attendanceElapsedMinutes(daily.clockInAt, timestamp);
    daily.clockOutAt = timestamp; daily.grossMinutes = grossMinutes; daily.netMinutes = Math.max(0, grossMinutes - 60);
    daily.status = 'COMPLETE'; daily.version += 1; daily.updatedAt = timestamp;
  }
  writeState(state);
  return { data: { attemptId: crypto.randomUUID(), accepted: true, result: 'ACCEPTED', dailyResult: daily, serverTime: timestamp } };
}

export async function mockUploadSharedWorkBatchLabel(batchId: string, firstLegTrackingNo: string, file: File) {
  const state = readState();
  const batch = state.batches.find(item => item.id === batchId);
  const item = batch?.items.find(candidate => candidate.firstLegTrackingNo === firstLegTrackingNo.replaceAll(/\s+/g, '').toUpperCase());
  if (!batch || !item) throw new WarehouseApiError(404, 'BATCH_ITEM_NOT_FOUND', '请先导入对应 Excel 映射');
  if (batch.status !== 'DRAFT' && batch.status !== 'ACTIVE') throw new WarehouseApiError(409, 'BATCH_NOT_EDITABLE', '只有草稿或生效中的批次可以上传面单');
  if (batch.status === 'ACTIVE' && item.labelAssetId) throw new WarehouseApiError(409, 'LABEL_ALREADY_READY', '生效批次只允许补传缺失面单，不能替换已有可用面单');
  const assetId = crypto.randomUUID();
  item.labelAssetId = assetId;
  labelFiles.set(assetId, file);
  batch.pdfCount = batch.items.filter(candidate => candidate.labelAssetId).length;
  batch.updatedAt = now();
  writeState(state);
  return { data: { id: assetId, byteSize: file.size } };
}

export async function mockDownloadWarehouseLabel(downloadPath: string): Promise<Blob> {
  const assetId = downloadPath.split('/').at(-2) ?? '';
  return labelFiles.get(assetId) ?? new Blob(['%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF'], { type: 'application/pdf' });
}

export async function mockUploadAirHandoverEvidence(batchId: string, input: {
  type: 'POD' | 'LOADING'; file: File; qualityWarnings?: string[]; qualityOverride?: boolean;
}) {
  const state = readState();
  const batch = state.airHandoverBatches.find(item => item.id === batchId);
  if (!batch) throw new WarehouseApiError(404, 'HANDOVER_BATCH_NOT_FOUND', '未找到交仓批次');
  if (batch.evidence.filter(item => item.type === input.type).length >= 9) throw new WarehouseApiError(409, 'EVIDENCE_LIMIT_REACHED', '每类凭证最多 9 张');
  const id = crypto.randomUUID();
  const createdAt = now();
  const asset = { id, type: input.type, filename: input.file.name, contentType: input.file.type as 'image/jpeg' | 'image/png',
    byteSize: input.file.size, width: 800, height: 600, qualityWarnings: input.qualityWarnings ?? [],
    qualityOverride: Boolean(input.qualityOverride), downloadPath: `/warehouse/v1/air-evidence-assets/${id}/content`, createdAt };
  batch.evidence.push(asset); evidenceFiles.set(id, input.file);
  await writeLocalFirstValue('airEvidence', id, input.file).catch(() => undefined);
  const evidenceStatus = mockEvidenceStatus(batch);
  state.airPickups.filter(order => order.handoverBatchId === batch.id).forEach(order => {
    order.evidenceStatus = evidenceStatus; order.version += 1; order.updatedAt = createdAt;
    order.handoverEvidence = [...batch.evidence];
    order.events.unshift(mockAirEvent('EVIDENCE_ADDED', null, [asset]));
  });
  writeState(state);
  return { data: { ...asset, evidenceStatus } };
}

export async function mockUploadAirReceiptEvidence(batchId: string, input: {
  file: File; qualityWarnings?: string[]; qualityOverride?: boolean;
}) {
  const state = readState();
  const orders = state.airPickups.filter(order => order.receiptBatchId === batchId);
  if (!orders.length) throw new WarehouseApiError(404, 'RECEIPT_BATCH_NOT_FOUND', '未找到入库批次');
  const existing = orders[0].receiptEvidence ?? [];
  if (existing.length >= 9) throw new WarehouseApiError(409, 'RECEIPT_EVIDENCE_LIMIT_REACHED', '入库照最多 9 张');
  const id = crypto.randomUUID();
  const createdAt = now();
  const asset = { id, type: 'RECEIPT' as const, filename: input.file.name,
    contentType: input.file.type as 'image/jpeg' | 'image/png', byteSize: input.file.size,
    width: 800, height: 600, qualityWarnings: input.qualityWarnings ?? [],
    qualityOverride: Boolean(input.qualityOverride),
    downloadPath: `/warehouse/v1/air-receipt-evidence-assets/${id}/content`, createdAt };
  evidenceFiles.set(id, input.file);
  await writeLocalFirstValue('airEvidence', id, input.file).catch(() => undefined);
  orders.forEach(order => {
    order.receiptEvidence = [...existing, asset];
    order.events.unshift(mockAirEvent('RECEIPT_EVIDENCE_ADDED', null, [asset]));
    order.updatedAt = createdAt;
  });
  writeState(state);
  return { data: asset };
}

export async function mockDownloadAirEvidence(downloadPath: string): Promise<Blob> {
  const assetId = downloadPath.split('/').at(-2) ?? '';
  const blob = evidenceFiles.get(assetId) ?? await readLocalFirstValue<Blob>('airEvidence', assetId).catch(() => null);
  if (!blob) throw new WarehouseApiError(404, 'EVIDENCE_NOT_FOUND', '凭证文件不可用，请重新上传后再预览');
  evidenceFiles.set(assetId, blob);
  return blob;
}

export async function mockUploadAirPickupDocument(orderId: string, file: File) {
  const state = readState();
  const order = state.airPickups.find(item => item.id === orderId);
  if (!order) throw new WarehouseApiError(404, 'AIR_PICKUP_NOT_FOUND', '未找到空运提货单');
  if (order.status === 'VOIDED') throw new WarehouseApiError(409, 'AIR_PICKUP_VOIDED', '已作废的提货单不能新增提货文件');
  const documents = order.pickupDocuments ?? [];
  if (documents.length >= 10) throw new WarehouseApiError(409, 'PICKUP_DOCUMENT_LIMIT_REACHED', '每张提货单最多上传 10 个提货文件');
  const extension = file.name.split('.').pop()?.toLowerCase();
  const types: Record<string, AirPickupDocument['contentType']> = {
    pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv',
  };
  if (!extension || !types[extension]) throw new WarehouseApiError(415, 'UNSUPPORTED_PICKUP_DOCUMENT', '仅支持 PDF、Word、Excel 或 CSV 提货文件');
  const id = crypto.randomUUID();
  const asset: AirPickupDocument = { id, filename: file.name, contentType: types[extension], byteSize: file.size,
    downloadPath: `/warehouse/v1/air-pickup-documents/${id}/content`, createdAt: now() };
  pickupDocumentFiles.set(id, file);
  await writeLocalFirstValue('airPickupDocuments', id, file).catch(() => undefined);
  order.pickupDocuments = [...documents, asset];
  order.events.unshift(mockAirEvent('PICKUP_DOCUMENT_ADDED'));
  order.updatedAt = asset.createdAt;
  writeState(state);
  return { data: asset };
}

export async function mockDownloadAirPickupDocument(downloadPath: string): Promise<Blob> {
  const assetId = downloadPath.split('/').at(-2) ?? '';
  const blob = pickupDocumentFiles.get(assetId) ?? await readLocalFirstValue<Blob>('airPickupDocuments', assetId).catch(() => null);
  if (!blob) throw new WarehouseApiError(404, 'PICKUP_DOCUMENT_NOT_FOUND', '提货文件不可用，请重新上传');
  pickupDocumentFiles.set(assetId, blob);
  return blob;
}

export const MOCK_WAREHOUSE_CREDENTIALS = { loginName: MOCK_LOGIN_NAME, password: MOCK_PASSWORD };
