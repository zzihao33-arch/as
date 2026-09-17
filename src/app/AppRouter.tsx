import { lazy } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import DashboardPage from '../pages/DashboardPage';
import FeaturePage from '../pages/FeaturePage';
import OperationsPage from '../pages/OperationsPage';
import { WarehouseSessionGate, useWarehouseSession } from '../features/session/WarehouseSessionProvider';

const BolPage = lazy(() => import('../pages/BolPage'));
const PayrollPage = lazy(() => import('../pages/PayrollPage'));
const AccountsPage = lazy(() => import('../pages/AccountsPage'));
const RolesPage = lazy(() => import('../pages/RolesPage'));
const AirPickupPage = lazy(() => import('../pages/AirPickupPage'));
const SystemStatusPage = lazy(() => import('../pages/SystemStatusPage'));

function RequireSession() {
  const session = useWarehouseSession();
  if (session.status === 'anonymous') return <Navigate to="/login" replace />;
  return <WarehouseSessionGate><Outlet /></WarehouseSessionGate>;
}

function LoginRoute() {
  return <WarehouseSessionGate><Navigate to="/" replace /></WarehouseSessionGate>;
}

function RequirePermission({ permission }: { permission: string }) {
  const session = useWarehouseSession();
  return session.hasPermission(permission) ? <Outlet /> : <Navigate to="/" replace />;
}

function RequireAnyPermission({ permissions }: { permissions: string[] }) {
  const session = useWarehouseSession();
  return permissions.some(permission => session.hasPermission(permission))
    ? <Outlet />
    : <Navigate to="/" replace />;
}

function FirstAllowedRoute() {
  const session = useWarehouseSession();
  const roleName = session.session?.roleName ?? '';
  const isOperationsRole = /操作员|operator/i.test(roleName);
  const isSupervisorRole = session.session?.platformRole === 'SYSTEM_ADMIN'
    || /主管|supervisor|manager|admin/i.test(roleName);

  // The first screen is a work decision, not a permission ordering accident.
  // Operators return to the scan console, while supervisory roles begin with
  // situational awareness. Other roles retain the previous safe fallback.
  if (isOperationsRole && session.hasPermission('scan.use')) {
    return <Navigate to="/operations/scan-print" replace />;
  }
  if (isSupervisorRole && session.hasPermission('dashboard.view')) {
    return <Navigate to="/dashboard" replace />;
  }
  const firstAllowed = [
    ['scan.use', '/operations/scan-print'],
    ['dashboard.view', '/dashboard'],
    ['air_pickups.view', '/air-pickups'],
    ['bol.view', '/air-pickups/handover-documents'],
    ['attendance.punch', '/payroll'],
    ['attendance.self_view', '/payroll'],
    ['attendance.appeal', '/payroll'],
    ['attendance.team_view', '/payroll'],
    ['attendance.review', '/payroll'],
    ['attendance.locations.manage', '/payroll'],
    ['attendance.rules.manage', '/payroll'],
    ['payroll.view', '/payroll'],
    ['accounts.view', '/admin/accounts'],
    ['roles.view', '/admin/roles'],
    ['settings.printer', '/settings/printer'],
    ['settings.audio', '/settings/audio'],
    ['system_status.view', '/settings/system'],
  ].find(([permission]) => session.hasPermission(permission));
  return firstAllowed
    ? <Navigate to={firstAllowed[1]} replace />
    : <RoutedFeature title="暂无可用功能" description="当前账号尚未分配任何功能权限，请联系系统管理员。" />;
}

function RoutedFeature({ title, description, actionLabel, actionPath }: {
  title: string;
  description: string;
  actionLabel?: string;
  actionPath?: string;
}) {
  return <FeaturePage title={title} description={description} actionLabel={actionLabel} actionPath={actionPath} />;
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route element={<RequireSession />}>
        <Route element={<AppShell />}>
          <Route index element={<FirstAllowedRoute />} />
          <Route element={<RequirePermission permission="dashboard.view" />}><Route path="/dashboard" element={<DashboardPage />} /></Route>
          <Route element={<RequirePermission permission="scan.use" />}><Route path="/operations/scan-print" element={<OperationsPage />} /></Route>
          <Route element={<RequirePermission permission="intercepts.view" />}>
            <Route path="/operations/intercepts" element={<Navigate to="/operations/scan-print#intercepts" replace />} />
          </Route>
          <Route element={<RequirePermission permission="air_pickups.view" />}><Route path="/air-pickups" element={<AirPickupPage />} /></Route>
          <Route element={<RequirePermission permission="air_pickups.view" />}><Route path="/air-pickups/history" element={<Navigate to="/air-pickups?scope=all" replace />} /></Route>
          <Route element={<RequirePermission permission="bol.view" />}>
            <Route path="/air-pickups/handover-documents" element={<BolPage />} />
          </Route>
          <Route element={<RequirePermission permission="batches.create" />}>
            <Route path="/operations/imports" element={<Navigate to="/operations/scan-print#data-import" replace />} />
          </Route>
          <Route
            path="/operations/activity"
            element={<Navigate to="/operations/scan-print" replace />}
          />
          <Route element={<RequirePermission permission="bol.view" />}>
            <Route path="/bol/records" element={<Navigate to="/air-pickups/handover-documents" replace />} />
            <Route path="/bol/new" element={<Navigate to="/air-pickups/handover-documents" replace />} />
            <Route path="/bol/:bolId" element={<Navigate to="/air-pickups/handover-documents" replace />} />
          </Route>
          <Route element={<RequireAnyPermission permissions={[
            'attendance.punch', 'attendance.self_view', 'attendance.appeal', 'attendance.team_view',
            'attendance.review', 'attendance.locations.manage', 'attendance.rules.manage', 'payroll.view',
          ]} />}><Route path="/payroll" element={<PayrollPage />} /></Route>
          <Route element={<RequirePermission permission="settings.printer" />}><Route path="/settings/printer" element={<Navigate to="/operations/scan-print?settings=printer" replace />} /></Route>
          <Route element={<RequirePermission permission="settings.audio" />}><Route path="/settings/audio" element={<Navigate to="/operations/scan-print?settings=audio" replace />} /></Route>
          <Route element={<RequirePermission permission="system_status.view" />}>
            <Route path="/settings/system" element={<SystemStatusPage />} />
          </Route>
          <Route element={<RequirePermission permission="accounts.view" />}><Route path="/admin/accounts" element={<AccountsPage />} /></Route>
          <Route element={<RequirePermission permission="roles.view" />}><Route path="/admin/roles" element={<RolesPage />} /></Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
