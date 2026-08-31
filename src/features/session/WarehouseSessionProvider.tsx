import { Alert, Button, Checkbox, Form, Input, Modal, Select, Spin, Typography } from '@arco-design/web-react';
import { Building2, Cloud, KeyRound, LogIn, RefreshCw } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  changeWarehousePassword,
  createWarehouseSession,
  deleteWarehouseSession,
  getWarehouseSession,
  registerWarehouseWorkstation,
  renewWarehouseSession,
  selectWarehouseWorkspace,
  WAREHOUSE_MOCK_API_ENABLED,
  type WarehouseSessionView,
  type WarehouseWorkstation,
} from './warehouseApi';

type SessionStatus = 'loading' | 'anonymous' | 'ready' | 'error';
type WarehouseSessionContextValue = {
  status: SessionStatus;
  session: WarehouseSessionView | null;
  workstation: WarehouseWorkstation | null;
  error: string;
  login(input: { loginName: string; password: string }): Promise<void>;
  logout(): Promise<void>;
  selectWorkspace(warehouseId: string): Promise<void>;
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<void>;
  hasPermission(permission: string): boolean;
  retry(): void;
};

const WarehouseSessionContext = createContext<WarehouseSessionContextValue | null>(null);
const INSTALLATION_ID_KEY = 'cmhub-workstation-installation-id-v1';
const WORKSTATION_NAME_KEY = 'cmhub-workstation-name-v1';
const REMEMBERED_LOGIN_KEY = 'cmhub-remembered-login-v1';

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
  const promptedExpiryRef = useRef('');

  const activate = useCallback(async (activeSession: WarehouseSessionView) => {
    const activeWorkstation = activeSession.warehouseId
      && activeSession.passwordState === 'ACTIVE'
      && (activeSession.permissions.includes('scan.use') || activeSession.permissions.includes('attendance.punch'))
      ? await registerWarehouseWorkstation(installationIdentity())
      : null;
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

  useEffect(() => {
    if (!session || session.passwordState !== 'ACTIVE') return;
    const promptAt = new Date(session.expiresAt).getTime() - 30 * 60_000;
    const delay = Math.max(0, promptAt - Date.now());
    const timer = window.setTimeout(() => {
      if (promptedExpiryRef.current === session.expiresAt) return;
      promptedExpiryRef.current = session.expiresAt;
      Modal.confirm({
        title: '登录即将过期',
        content: '是否继续当前仓库作业？确认后会在 16 小时单次上限内续期。',
        okText: '继续使用',
        cancelText: '稍后处理',
        onOk: async () => { await activate(await renewWarehouseSession()); },
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [activate, session]);

  const value = useMemo<WarehouseSessionContextValue>(() => ({
    status,
    session,
    workstation,
    error,
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
    async selectWorkspace(warehouseId) {
      setStatus('loading');
      try {
        await activate(await selectWarehouseWorkspace(warehouseId));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '无法进入仓库。');
        setStatus('ready');
        throw cause;
      }
    },
    async changePassword(input) {
      await changeWarehousePassword(input);
      const restored = await getWarehouseSession();
      if (!restored) throw new Error('登录会话已失效，请重新登录。');
      await activate(restored);
    },
    hasPermission(permission) {
      return Boolean(session?.permissions.includes(permission));
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

function PasswordChangeGate({ children }: { children: ReactNode }) {
  const warehouseSession = useWarehouseSession();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  if (warehouseSession.session?.passwordState !== 'CHANGE_REQUIRED') return <>{children}</>;
  return (
    <main className="cmhub-login-page">
      <section className="cmhub-login-card" aria-labelledby="change-password-title">
        <div className="cmhub-login-mark"><KeyRound size={21} /></div>
        <div>
          <Typography.Title id="change-password-title" heading={3}>设置你的正式密码</Typography.Title>
          <Typography.Paragraph>这是初始密码首次使用。修改后其他临时会话会立即失效。</Typography.Paragraph>
        </div>
        {message && <Alert type="error" content={message} />}
        <Form form={form} layout="vertical" onSubmit={async values => {
          const input = values as { currentPassword: string; newPassword: string; confirmPassword: string };
          if (input.newPassword !== input.confirmPassword) {
            setMessage('两次输入的新密码不一致。');
            return;
          }
          setSubmitting(true);
          setMessage('');
          try {
            await warehouseSession.changePassword(input);
          } catch (cause) {
            setMessage(cause instanceof Error ? cause.message : '密码修改失败。');
          } finally {
            setSubmitting(false);
          }
        }}>
          <Form.Item label="当前临时密码" field="currentPassword" rules={[{ required: true, message: '请输入当前临时密码' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item label="新密码" field="newPassword" rules={[{ required: true, minLength: 16, message: '新密码至少 16 个字符' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item label="确认新密码" field="confirmPassword" rules={[{ required: true, message: '请再次输入新密码' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button htmlType="submit" type="primary" long loading={submitting}>保存并进入系统</Button>
        </Form>
      </section>
    </main>
  );
}

function WorkspaceGate({ children }: { children: ReactNode }) {
  const warehouseSession = useWarehouseSession();
  const [warehouseId, setWarehouseId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const activeSession = warehouseSession.session;
  if (!activeSession || activeSession.warehouseId || activeSession.workspaces.length === 0) return <>{children}</>;
  return (
    <main className="cmhub-login-page">
      <section className="cmhub-login-card" aria-labelledby="workspace-title">
        <div className="cmhub-login-mark"><Building2 size={21} /></div>
        <div>
          <Typography.Title id="workspace-title" heading={3}>选择仓库工作空间</Typography.Title>
          <Typography.Paragraph>账号 {activeSession.loginName} 可进入多个仓库。业务数据仍按已确认规则全员共享。</Typography.Paragraph>
        </div>
        {message && <Alert type="error" content={message} />}
        <Select
          aria-label="仓库工作空间"
          placeholder="选择要进入的仓库"
          value={warehouseId || undefined}
          onChange={setWarehouseId}
          options={activeSession.workspaces.map(workspace => ({
            value: workspace.warehouseId,
            label: `${workspace.warehouseName} · ${workspace.roleName ?? '系统管理员'}`,
          }))}
        />
        <Button type="primary" long disabled={!warehouseId} loading={submitting} onClick={async () => {
          setSubmitting(true);
          setMessage('');
          try {
            await warehouseSession.selectWorkspace(warehouseId);
          } catch (cause) {
            setMessage(cause instanceof Error ? cause.message : '无法进入仓库。');
          } finally {
            setSubmitting(false);
          }
        }}>进入工作空间</Button>
      </section>
    </main>
  );
}

export function WarehouseSessionGate({ children }: { children: ReactNode }) {
  const warehouseSession = useWarehouseSession();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [loginError, setLoginError] = useState('');
  const rememberedLogin = localStorage.getItem(REMEMBERED_LOGIN_KEY) ?? '';

  if (warehouseSession.status === 'ready') {
    return <PasswordChangeGate><WorkspaceGate>{children}</WorkspaceGate></PasswordChangeGate>;
  }
  if (warehouseSession.status === 'loading') {
    return <div className="cmhub-session-loading"><Spin size={32} /><span>正在验证登录会话…</span></div>;
  }
  if (warehouseSession.status === 'error') {
    return (
      <main className="cmhub-login-page">
        <section className="cmhub-login-card">
          <Cloud size={30} />
          <Typography.Title heading={3}>云端连接不可用</Typography.Title>
          <Alert type="error" content={warehouseSession.error} />
          <Button type="primary" icon={<RefreshCw size={16} />} onClick={warehouseSession.retry}>重新连接</Button>
        </section>
      </main>
    );
  }
  return (
    <main className="cmhub-login-page">
      <section className="cmhub-login-card" aria-labelledby="login-title">
        <div className="cmhub-login-mark">C</div>
        <div>
          <Typography.Title id="login-title" heading={3}>登录 CM-HUB 仓库工作台</Typography.Title>
          <Typography.Paragraph>使用内部账号登录。上游 API Key 不应填写在浏览器中。</Typography.Paragraph>
        </div>
        {WAREHOUSE_MOCK_API_ENABLED && (
          <Alert type="info" content="本地 Mock 测试账号：admin　密码：CMHub-Local-2026!（不会连接线上）" />
        )}
        {(loginError || warehouseSession.error) && <Alert type="error" content={loginError || warehouseSession.error} />}
        <Form
          form={form}
          layout="vertical"
          initialValues={{ loginName: rememberedLogin, remember: true }}
          onSubmit={async values => {
            const input = values as { loginName: string; password: string; remember: boolean };
            setSubmitting(true);
            setLoginError('');
            try {
              if (input.remember) localStorage.setItem(REMEMBERED_LOGIN_KEY, input.loginName.trim().toLowerCase());
              else localStorage.removeItem(REMEMBERED_LOGIN_KEY);
              await warehouseSession.login({ loginName: input.loginName, password: input.password });
            } catch (cause) {
              setLoginError(cause instanceof Error ? cause.message : '登录失败。');
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <Form.Item label="账号" field="loginName" rules={[{ required: true, message: '请输入账号' }]}>
            <Input autoFocus autoComplete="username" maxLength={50} placeholder="输入内部账号" />
          </Form.Item>
          <Form.Item label="密码" field="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item field="remember" triggerPropName="checked"><Checkbox>记住账号</Checkbox></Form.Item>
          <Button htmlType="submit" type="primary" long loading={submitting} icon={<LogIn size={16} />}>登录工作台</Button>
        </Form>
        <span className="cmhub-login-version">CM-HUB · v0.1.0</span>
      </section>
    </main>
  );
}
