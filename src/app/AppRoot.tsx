import { ConfigProvider } from '@arco-design/web-react';
import { BrowserRouter } from 'react-router-dom';
import { AppErrorBoundary } from './AppErrorBoundary';
import { AppRouter } from './AppRouter';
import { ThemeProvider } from './theme/ThemeProvider';

export default function AppRoot() {
  return (
    <AppErrorBoundary>
      <ThemeProvider>
        <ConfigProvider
          componentConfig={{
            Button: { shape: 'round' },
            Card: { bordered: false },
          }}
        >
          <BrowserRouter>
            <AppRouter />
          </BrowserRouter>
        </ConfigProvider>
      </ThemeProvider>
    </AppErrorBoundary>
  );
}
