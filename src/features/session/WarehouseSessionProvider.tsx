import { Alert, Button, Form, Input, Spin, Typography } from '@arco-design/web-react';
import { Cloud, LogIn, RefreshCw } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  createWarehouseSession,
  deleteWarehouseSession,
  getWarehouseSession,
  registerWarehouseWorkstation,
  type WarehouseSessionView,
  type WarehouseWorkstation,
} from './warehouseApi';

type SessionStatus = 'loading' | 'anonymous' | 'ready' | 'error';
type WarehouseSessionContextValue = {
  status: SessionStatus;
  session: WarehouseSessionView | null;
  workstation: WarehouseWorkstation | null;
  error: string;
  login(input: { email: string; password: string; warehouseCode: string }): Promise<void>;
  logout(): Promise<void>;
  retry(): void;
};

const WarehouseSessionContext = createContext<WarehouseSessionContextValue | null>(null);
const INSTALLATION_ID_KEY = 'cmhub-workstation-installation-id-v1';
const WORKSTATION_NAME_KEY = 'cmhub-workstation-name-v1';

function installationIdentity() {
  let installationId = localStorage.getItem(INSTALLATION_ID_KEY);
  if (!installationId) {
    installationId = crypto.randomUUID();
    localStorage.setItem(INSTALLATION_ID_KEY, installationId);
  }
  let displayName = localStorage.getItem(WORKSTATION_NAME_KEY);
  if (!displayName) {
    displayName = '仓库浏览器工作站';
    localStorage.setItem(WORKSTATION_NAME_KEY, displayName);
  }
  return { installationId, displayName };
}
export function WarehouseSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [session, setSession] = useState<WarehouseSessionView | null>(null);
  const [workstation, setWorkstation] = useState<WarehouseWorkstation | null>(null);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const activate = useCallback(async (activeSession: WarehouseSessionView) => {
    const activeWorkstation = await registerWarehouseWorkstation(installationIdentity());
    setSession(activeSession);
    setWorkstation(activeWorkstation);
    setError('');
    setStatus('ready');
  }, []);

  useEffect(() => {
    let current = true;
    setStatus('loading');
    void getWarehouseSession().then(async restored => {
      if (!current) return;
      if (!restored) {
        setSession(null);
        setWorkstation(null);
        setStatus('anonymous');
        return;
      }
      await activate(restored);
    }).catch(cause => {
      if (!current) return;
      setError(cause instanceof Error ? cause.message : '无法连接仓库云端服务。');
      setStatus('error');
    });
    return () => { current = false; };
  }, [activate, reloadKey]);

  const value = useMemo<WarehouseSessionContextValue>(() => ({
    status, session, workstation, error,
    async login(input) {
      setStatus('loading');
      try {
        await activate(await createWarehouseSession(input));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '登录失败。');
        setStatus('anonymous');
        throw cause;
      }
    },
    async logout() {
      await deleteWarehouseSession().catch(() => undefined);
      setSession(null);
      setWorkstation(null);
      setStatus('anonymous');
    },
    retry() { setReloadKey(key => key + 1); },
  }), [activate, error, session, status, workstation]);

  return <WarehouseSessionContext.Provider value={value}>{children}</WarehouseSessionContext.Provider>;
}

export function useWarehouseSession() {
  const context = useContext(WarehouseSessionContext);
  if (!context) throw new Error('useWarehouseSession must be used inside WarehouseSessionProvider.');
  return context;
}

export function WarehouseSessionGate({ children }: { children: ReactNode }) {
  const session = useWarehouseSession();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [loginError, setLoginError] = useState('');
  if (session.status === 'ready') return <>{children}</>;
  if (session.status === 'loading') {
    return <div className="cmhub-session-loading"><Spin size={32} /><span>正在验证仓库会话…</span></div>;
  }
  if (session.status === 'error') {
    return (
      <main className="cmhub-login-page">
        <section className="cmhub-login-card">
          <Cloud size={30} />
          <Typography.Title heading={3}>云端连接不可用</Typography.Title>
          <Alert type="error" content={session.error} />
          <Button type="primary" icon={<RefreshCw size={16} />} onClick={session.retry}>重新连接</Button>
        </section>
      </main>
    );
  }
  return (
    <main className="cmhub-login-page">
      <section className="cmhub-login-card">
        <div className="cmhub-login-mark">C</div>
        <div>
          <Typography.Title heading={3}>登录 CM-HUB 仓库工作台</Typography.Title>
          <Typography.Paragraph>使用内部仓库账号登录。上游 API Key 不应填写在浏览器中。</Typography.Paragraph>
        </div>
        {(loginError || session.error) && <Alert type="error" content={loginError || session.error} />}
        <Form form={form} layout="vertical" onSubmit={async values => {
          setSubmitting(true);
          setLoginError('');
          try {
            await session.login(values as { email: string; password: string; warehouseCode: string });
          } catch (cause) {
            setLoginError(cause instanceof Error ? cause.message : '登录失败。');
          } finally {
            setSubmitting(false);
          }
        }}>
          <Form.Item label="仓库代码" field="warehouseCode" rules={[{ required: true, message: '请输入仓库代码' }]}>
            <Input autoComplete="organization" placeholder="例如 jfk-warehouse" />
          </Form.Item>
          <Form.Item label="邮箱" field="email" rules={[{ required: true, message: '请输入邮箱' }]}>
            <Input autoComplete="username" placeholder="name@company.com" />
          </Form.Item>
          <Form.Item label="密码" field="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button htmlType="submit" type="primary" long loading={submitting} icon={<LogIn size={16} />}>登录工作台</Button>
        </Form>
      </section>
    </main>
  );
}
