import { lazy } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import DashboardPage from '../pages/DashboardPage';
import FeaturePage from '../pages/FeaturePage';
import InterceptPage from '../pages/InterceptPage';
import OperationsPage from '../pages/OperationsPage';

const BolPage = lazy(() => import('../pages/BolPage'));
const PayrollPage = lazy(() => import('../pages/PayrollPage'));

function RequireSession() {
  // The current product has no server-side account flow. Keeping this boundary now
  // makes a future Auth module additive instead of requiring route rewrites.
  return <Outlet />;
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
      <Route element={<RequireSession />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/operations/scan-print" element={<OperationsPage />} />
          <Route path="/operations/intercepts" element={<InterceptPage />} />
          <Route
            path="/operations/imports"
            element={<Navigate to="/operations/scan-print#data-import" replace />}
          />
          <Route
            path="/operations/activity"
            element={<Navigate to="/operations/scan-print" replace />}
          />
          <Route
            path="/bol/records"
            element={<BolPage />}
          />
          <Route path="/bol/new" element={<BolPage />} />
          <Route path="/bol/:bolId" element={<BolPage />} />
          <Route path="/payroll" element={<PayrollPage />} />
          <Route path="/settings/printer" element={<Navigate to="/operations/scan-print?settings=printer" replace />} />
          <Route path="/settings/audio" element={<Navigate to="/operations/scan-print?settings=audio" replace />} />
          <Route
            path="/settings/system"
            element={<RoutedFeature title="系统状态" description="本机桥接、QZ Tray 与业务运行状态将在此集中展示。" actionLabel="打开运营工作台" actionPath="/dashboard" />}
          />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/operations/scan-print" replace />} />
    </Routes>
  );
}
