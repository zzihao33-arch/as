import { Avatar, Badge, Breadcrumb, Button, Layout, Menu, Select, Tooltip } from '@arco-design/web-react';
import {
  BarChart3,
  LayoutDashboard,
  FilePlus2,
  Menu as MenuIcon,
  PackageSearch,
  Printer,
  Settings2,
  ShieldAlert,
  Volume2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { type ThemeMode, useTheme } from './theme/ThemeProvider';

interface NavigationItem {
  key: string;
  label: string;
  group: string;
  icon: typeof PackageSearch;
}

const navigationItems: NavigationItem[] = [
  { key: '/dashboard', label: '工作概览', group: '运营中心', icon: LayoutDashboard },
  { key: '/operations/scan-print', label: '扫码打单', group: '运营中心', icon: PackageSearch },
  { key: '/operations/intercepts', label: '拦截名单', group: '运营中心', icon: ShieldAlert },
  { key: '/bol/records', label: 'BOL管理', group: '单据与结算', icon: FilePlus2 },
  { key: '/payroll', label: '考勤薪酬', group: '单据与结算', icon: BarChart3 },
  { key: '/settings/printer', label: '打印机', group: '系统设置', icon: Printer },
  { key: '/settings/audio', label: '音效设置', group: '系统设置', icon: Volume2 },
  { key: '/settings/system', label: '系统状态', group: '系统设置', icon: Settings2 },
];

function getActiveItem(pathname: string) {
  return [...navigationItems]
    .sort((a, b) => b.key.length - a.key.length)
    .find((item) => pathname === item.key || pathname.startsWith(`${item.key}/`)) ?? navigationItems[0];
}

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const activeItem = useMemo(
    () => getActiveItem(location.pathname),
    [location.pathname],
  );
  const { mode, setMode } = useTheme();

  const groupedNavigation = useMemo(() => {
    return navigationItems.reduce<Record<string, NavigationItem[]>>((groups, item) => {
      (groups[item.group] ??= []).push(item);
      return groups;
    }, {});
  }, []);

  const openRoute = (path: string) => {
    setMobileNavigationOpen(false);
    navigate(path);
  };

  return (
    <Layout className="cmhub-shell">
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
                selectedKeys={[activeItem.key]}
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
          <Badge status="success" text="本机工作台" />
          <span>QZ 打印通过当前电脑执行</span>
          <small>数据仅保存在当前浏览器；清理缓存会影响历史与草稿。</small>
        </div>
      </Layout.Sider>

      <Layout className="cmhub-main-layout">
        <header className="cmhub-topbar">
          <div className="cmhub-topbar-heading">
            <Button
              aria-label="打开导航"
              className="cmhub-mobile-menu-button"
              type="text"
              icon={<MenuIcon size={21} />}
              onClick={() => setMobileNavigationOpen(true)}
            />
            <Breadcrumb>
              <Breadcrumb.Item>CM-HUB</Breadcrumb.Item>
              <Breadcrumb.Item>{activeItem.group}</Breadcrumb.Item>
              <Breadcrumb.Item>{activeItem.label}</Breadcrumb.Item>
            </Breadcrumb>
          </div>
          <div className="cmhub-topbar-actions">
            <Select
              aria-label="界面主题"
              className="cmhub-theme-select"
              size="small"
              value={mode}
              options={[
                { label: '跟随系统', value: 'auto' },
                { label: '浅色模式', value: 'light' },
                { label: '深色模式', value: 'dark' },
              ]}
              onChange={(value) => setMode(value as ThemeMode)}
            />
            <Tooltip content="当前浏览器与本机服务会话">
              <span className="cmhub-online-status"><i /> 本机模式</span>
            </Tooltip>
            <Avatar size={30} className="cmhub-user-avatar">C</Avatar>
          </div>
        </header>

        <Layout.Content className="cmhub-content">
          {/*
            THESIS: A focused warehouse workbench, not a generic analytics dashboard.
            OWN-WORLD: Arco structure with CM-HUB green only for operational state and primary action.
            STORY: Operators move from current status to a focused task without losing access to print controls.
            FIRST VIEWPORT: Persistent navigation, compact context bar, then task content at full working width.
            FORM: Arco enterprise application shell; implementation phase 1, design-context unavailable until a Figma layer is selected.
            FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
          */}
          <Outlet />
        </Layout.Content>
      </Layout>

      {mobileNavigationOpen && (
        <div className="cmhub-mobile-navigation" role="dialog" aria-modal="true" aria-label="主导航">
          <button aria-label="关闭导航" className="cmhub-mobile-navigation-backdrop" onClick={() => setMobileNavigationOpen(false)} />
          <aside>
            <div className="cmhub-mobile-navigation-header">
              <strong>CM-HUB</strong>
              <Button aria-label="关闭导航" type="text" icon={<X size={21} />} onClick={() => setMobileNavigationOpen(false)} />
            </div>
            {Object.entries(groupedNavigation).map(([group, items]) => (
              <section className="cmhub-nav-group" key={group} aria-label={group}>
                <p>{group}</p>
                {items.map((item) => {
                  const Icon = item.icon;
                  const selected = activeItem.key === item.key;
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
    </Layout>
  );
}
