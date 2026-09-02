import { Avatar, Button, Dropdown, Form, Input, Layout, Menu, Message, Modal, Select, Spin } from '@arco-design/web-react';
import {
  BarChart3,
  LayoutDashboard,
  LogOut,
  KeyRound,
  Menu as MenuIcon,
  PackageSearch,
  Plane,
  Printer,
  Settings2,
  ShieldCheck,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { type ThemeMode, useTheme } from './theme/ThemeProvider';
import { useWarehouseSession } from '../features/session/WarehouseSessionProvider';
import { WAREHOUSE_MOCK_API_ENABLED } from '../features/session/warehouseApi';

interface NavigationItem {
  key: string;
  label: string;
  group: string;
  icon: typeof PackageSearch;
  permissions: string[];
}

const navigationItems: NavigationItem[] = [
  { key: '/dashboard', label: '工作概览', group: '运营中心', icon: LayoutDashboard, permissions: ['dashboard.view'] },
  { key: '/operations/scan-print', label: '扫码打单', group: '运营中心', icon: PackageSearch, permissions: ['scan.use'] },
  { key: '/air-pickups', label: '空提管理', group: '单据与结算', icon: Plane, permissions: ['air_pickups.view', 'bol.view'] },
  { key: '/payroll', label: '考勤薪酬', group: '单据与结算', icon: BarChart3, permissions: [
    'attendance.punch', 'attendance.self_view', 'attendance.appeal', 'attendance.team_view',
    'attendance.review', 'attendance.locations.manage', 'attendance.rules.manage', 'payroll.view',
  ] },
  { key: '/admin/accounts', label: '账户管理', group: '管理中心', icon: Users, permissions: ['accounts.view'] },
  { key: '/admin/roles', label: '角色配置', group: '管理中心', icon: ShieldCheck, permissions: ['roles.view'] },
  { key: '/settings/printer', label: '打印机', group: '系统设置', icon: Printer, permissions: ['settings.printer'] },
  { key: '/settings/audio', label: '音效设置', group: '系统设置', icon: Volume2, permissions: ['settings.audio'] },
  { key: '/settings/system', label: '系统状态', group: '系统设置', icon: Settings2, permissions: ['system_status.view'] },
];

function getActiveItem(pathname: string, items: NavigationItem[]) {
  return [...items]
    .sort((a, b) => b.key.length - a.key.length)
    .find((item) => pathname === item.key || pathname.startsWith(`${item.key}/`)) ?? items[0];
}

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordForm] = Form.useForm();
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileNavigationRef = useRef<HTMLElement>(null);
  const { mode, setMode } = useTheme();
  const warehouseSession = useWarehouseSession();
  const visibleNavigation = useMemo(() => navigationItems
    .filter(item => item.permissions.some(permission => warehouseSession.hasPermission(permission)))
    .map(item => item.key === '/air-pickups'
      && !warehouseSession.hasPermission('air_pickups.view')
      && warehouseSession.hasPermission('bol.view')
      ? { ...item, key: '/air-pickups/handover-documents' }
      : item), [warehouseSession]);
  const activeItem = useMemo(
    () => getActiveItem(location.pathname, visibleNavigation),
    [location.pathname, visibleNavigation],
  );

  const groupedNavigation = useMemo(() => {
    return visibleNavigation.reduce<Record<string, NavigationItem[]>>((groups, item) => {
      (groups[item.group] ??= []).push(item);
      return groups;
    }, {});
  }, [visibleNavigation]);

  const openRoute = (path: string) => {
    setMobileNavigationOpen(false);
    // AppRoot opts out of BrowserRouter's concurrent transitions so the new
    // work surface replaces the previous page in this same navigation event.
    void navigate(path);
  };

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    const main = document.getElementById('cmhub-main-content');
    if (main) main.scrollTop = 0;

    const frame = window.requestAnimationFrame(() => {
      main?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileNavigationOpen) return;

    const navigation = mobileNavigationRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      navigation?.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled])')?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileNavigationOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !navigation) return;

      const focusable = [...navigation.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      (previouslyFocused ?? mobileMenuTriggerRef.current)?.focus();
    };
  }, [mobileNavigationOpen]);

  return (
    <Layout className="cmhub-shell">
      <a className="cmhub-skip-link" href="#cmhub-main-content">跳至主要内容</a>
      <Layout.Sider className="cmhub-sider" collapsible={false}>
        <div className="cmhub-brand" aria-label="CM-HUB">
          <span className="cmhub-brand-mark">C</span>
          <span>CM-HUB</span>
        </div>
        <nav aria-label="主导航" className="cmhub-nav">
          {Object.entries(groupedNavigation).map(([group, items]) => (
            <section className="cmhub-nav-group" key={group} aria-label={group}>
              <p>{group}</p>
              <Menu
                selectedKeys={activeItem ? [activeItem.key] : []}
                onClickMenuItem={openRoute}
                collapse={false}
                className="cmhub-menu"
              >
                {items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Menu.Item key={item.key}>
                      <Icon aria-hidden="true" size={17} strokeWidth={2} />
                      <span>{item.label}</span>
                    </Menu.Item>
                  );
                })}
              </Menu>
            </section>
          ))}
        </nav>
        <div className="cmhub-sider-footer">
          <span className="cmhub-workspace-status"><i /> {warehouseSession.session?.warehouseName ?? '仓库工作台'}</span>
          <span className="cmhub-online-status cmhub-sider-online-status"><i /> {WAREHOUSE_MOCK_API_ENABLED ? '本地 Mock' : '云端已连接'} · QZ 本机打印</span>
          <small>面单按仓库权限同步至当前浏览器；上游密钥不会进入本机。</small>
          <Select
            aria-label="界面主题"
            className="cmhub-sider-theme-select"
            size="small"
            value={mode}
            options={[
              { label: '跟随系统', value: 'auto' },
              { label: '浅色模式', value: 'light' },
              { label: '深色模式', value: 'dark' },
            ]}
            onChange={(value) => setMode(value as ThemeMode)}
          />
          <Dropdown
            trigger="click"
            droplist={(
              <Menu onClickMenuItem={key => {
                if (key === 'password') setPasswordOpen(true);
                if (key === 'logout') {
                  Modal.confirm({
                    title: '退出当前账号？',
                    content: '请确认本机打印任务已完成。退出后会清除登录凭证。',
                    okText: '退出登录',
                    onOk: () => warehouseSession.logout(),
                  });
                }
              }}>
                <Menu.Item key="password"><KeyRound size={15} />修改密码</Menu.Item>
                <Menu.Item key="logout"><LogOut size={15} />退出登录</Menu.Item>
              </Menu>
            )}
          >
            <button className="cmhub-user-menu-trigger cmhub-sider-user-menu" aria-label="打开账户菜单">
              <Avatar size={30} className="cmhub-user-avatar">{warehouseSession.session?.userName.slice(0, 1) ?? 'C'}</Avatar>
              <span>
                <strong>{warehouseSession.session?.userName ?? '仓库用户'}</strong>
                <small>{warehouseSession.session?.platformRole === 'SYSTEM_ADMIN' ? '系统管理员' : warehouseSession.session?.roleName ?? '未分配角色'}</small>
              </span>
            </button>
          </Dropdown>
        </div>
      </Layout.Sider>

      <Layout className="cmhub-main-layout">
        <Layout.Content id="cmhub-main-content" className="cmhub-content" role="main" tabIndex={-1}>
          <Suspense
            fallback={(
              <div className="cmhub-route-loader" role="status" aria-live="polite" aria-label="正在切换页面">
                <Spin size={28} />
              </div>
            )}
          >
            <div className="cmhub-route-stage" key={location.pathname}>
              <Outlet />
            </div>
          </Suspense>
        </Layout.Content>
        <Button
          ref={mobileMenuTriggerRef}
          aria-label="打开导航"
          className="cmhub-mobile-menu-button cmhub-mobile-menu-fab"
          type="primary"
          icon={<MenuIcon size={20} />}
          onClick={() => setMobileNavigationOpen(true)}
        />
      </Layout>

      {mobileNavigationOpen && (
        <div className="cmhub-mobile-navigation" role="dialog" aria-modal="true" aria-label="主导航">
          <button aria-label="关闭导航" className="cmhub-mobile-navigation-backdrop" onClick={() => setMobileNavigationOpen(false)} />
          <aside ref={mobileNavigationRef}>
            <div className="cmhub-mobile-navigation-header">
              <strong>CM-HUB</strong>
              <Button aria-label="关闭导航" type="text" icon={<X size={21} />} onClick={() => setMobileNavigationOpen(false)} />
            </div>
            {Object.entries(groupedNavigation).map(([group, items]) => (
              <section className="cmhub-nav-group" key={group} aria-label={group}>
                <p>{group}</p>
                {items.map((item) => {
                  const Icon = item.icon;
                  const selected = activeItem?.key === item.key;
                  return (
                    <button className={selected ? 'is-active' : ''} key={item.key} onClick={() => openRoute(item.key)}>
                      <Icon size={17} aria-hidden="true" />
                      {item.label}
                    </button>
                  );
                })}
              </section>
            ))}
          </aside>
        </div>
      )}

      <Modal
        title="修改密码"
        visible={passwordOpen}
        confirmLoading={passwordSaving}
        okText="保存新密码"
        onCancel={() => { setPasswordOpen(false); passwordForm.resetFields(); }}
        onOk={() => passwordForm.submit()}
        unmountOnExit
      >
        <Form form={passwordForm} layout="vertical" onSubmit={async values => {
          const input = values as { currentPassword: string; newPassword: string; confirmPassword: string };
          if (input.newPassword !== input.confirmPassword) {
            Message.error('两次输入的新密码不一致');
            return;
          }
          setPasswordSaving(true);
          try {
            await warehouseSession.changePassword(input);
            setPasswordOpen(false);
            passwordForm.resetFields();
            Message.success('密码已更新');
          } catch (cause) {
            Message.error(cause instanceof Error ? cause.message : '密码修改失败。');
          } finally {
            setPasswordSaving(false);
          }
        }}>
          <Form.Item label="当前密码" field="currentPassword" rules={[{ required: true, message: '请输入当前密码' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item label="新密码" field="newPassword" rules={[{ required: true, minLength: 16, message: '新密码至少 16 个字符' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item label="确认新密码" field="confirmPassword" rules={[{ required: true, message: '请再次输入新密码' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </Layout>
  );
}
