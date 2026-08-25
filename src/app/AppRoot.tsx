import { ConfigProvider, Spin } from '@arco-design/web-react';
import { BrowserRouter } from 'react-router-dom';
import { AppRouter } from './AppRouter';
import { ThemeProvider } from './theme/ThemeProvider';

export default function AppRoot() {
  return (
    <ThemeProvider>
      <ConfigProvider
        componentConfig={{
          Button: { shape: 'round' },
          Card: { bordered: false },
        }}
      >
        <BrowserRouter>
          <AppRouter fallback={<Spin size={28} className="app-route-loader" />} />
        </BrowserRouter>
      </ConfigProvider>
    </ThemeProvider>
  );
}
