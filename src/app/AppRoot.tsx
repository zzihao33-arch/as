import { ConfigProvider } from 'tdesign-react';
import { BrowserRouter } from 'react-router-dom';
import { AppErrorBoundary } from './AppErrorBoundary';
import { AppRouter } from './AppRouter';
import { ThemeProvider } from './theme/ThemeProvider';
import { WarehouseSessionProvider } from '../features/session/WarehouseSessionProvider';

export default function AppRoot() {
  return (
    <AppErrorBoundary>
      <ThemeProvider>
        <WarehouseSessionProvider>
          <ConfigProvider globalConfig={{}}>
            <BrowserRouter useTransitions={false}>
              <AppRouter />
            </BrowserRouter>
          </ConfigProvider>
        </WarehouseSessionProvider>
      </ThemeProvider>
    </AppErrorBoundary>
  );
}
