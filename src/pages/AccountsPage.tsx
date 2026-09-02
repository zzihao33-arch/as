import {
  Alert,
  Button,
  Dropdown,
  Empty,
  Form,
  Input,
  Menu,
  Message,
  Modal,
  Select,
  Table,
  Tag,
} from '@arco-design/web-react';
import {
  BadgeCheck,
  Check,
  CheckCircle2,
  Copy,
  FilterX,
  KeyRound,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserRoundCheck,
  UserRoundX,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkbenchMotion } from '../features/motion/useWorkbenchMotion';
import {
  createWarehouseAccount,
  deleteWarehouseAccount,
  assignWarehouseAccountRole,
  listWarehouseAccounts,
  listWarehouseRoles,
  resetWarehouseAccountPassword,
  unlockWarehouseAccount,
  updateWarehouseAccount,
  type WarehouseAccount,
  type WarehouseRoleView,
} from '../features/session/warehouseApi';
import { useWarehouseSession } from '../features/session/WarehouseSessionProvider';

type AccountMenuAction = 'toggle-status' | 'unlock' | 'reset-password' | 'delete';

const accountActionKey = (accountId: string, action: string) => `${accountId}:${action}`;

function formatLastLogin(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    date: date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }),
    time: date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}

function TemporaryPasswordResult({ loginName, password }: { loginName: string; password: string }) {
  const [copied, setCopied] = useState(false);

  const copyCredentials = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(`${loginName}\n${password}`);
      setCopied(true);
      Message.success('账号与临时密码已复制');
    } catch {
      Message.error('自动复制失败，请手动选择并复制登录信息。');
    }
  };

  return (
    <div className="cmhub-secret-result">
      <div className="cmhub-secret-notice">
        <ShieldCheck size={20} aria-hidden="true" />
        <div>
          <strong>此密码仅显示一次</strong>
          <p>请通过安全渠道交给员工，并确认已妥善保存后再关闭。</p>
        </div>
      </div>
      <dl aria-label="新账户登录凭据">
        <div>
          <dt>登录账号</dt>
          <dd className="cmhub-mono">{loginName}</dd>
        </div>
        <div>
          <dt>临时密码</dt>
          <dd className="cmhub-mono cmhub-secret-password">{password}</dd>
        </div>
      </dl>
      <div className="cmhub-secret-copy-row">
        <Button
          className="cmhub-icon-label-button cmhub-secret-copy-button"
          type={copied ? 'secondary' : 'primary'}
          icon={copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
          onClick={() => void copyCredentials()}
        >
          {copied ? '已复制登录信息' : '复制登录信息'}
        </Button>
        <span role="status" aria-live="polite">{copied ? '可直接发送给员工' : '复制内容包含账号和临时密码'}</span>
      </div>
    </div>
  );
}

function showTemporaryPassword(title: string, loginName: string, password: string) {
  Modal.success({
    className: 'cmhub-account-secret-modal',
    simple: false,
    icon: null,
    title: (
      <span className="cmhub-account-secret-title">
        <CheckCircle2 size={20} aria-hidden="true" />
        {title}
      </span>
    ),
    content: <TemporaryPasswordResult loginName={loginName} password={password} />,
    okText: '我已安全保存',
    closable: false,
    maskClosable: false,
    escToExit: false,
    autoFocus: true,
    focusLock: true,
    style: { width: 520 },
  });
}

export default function AccountsPage() {
  const warehouseSession = useWarehouseSession();
  const pageRef = useRef<HTMLElement>(null);
  const requestSequence = useRef(0);
  const [accounts, setAccounts] = useState<WarehouseAccount[]>([]);
  const [roles, setRoles] = useState<WarehouseRoleView[]>([]);
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<WarehouseAccount | null>(null);
  const [creating, setCreating] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [listRevision, setListRevision] = useState(0);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const canManage = warehouseSession.hasPermission('accounts.manage');
  const canResetPassword = warehouseSession.hasPermission('accounts.reset_password');
  const canViewRoles = warehouseSession.hasPermission('roles.view');
  const activeFilterCount = Number(Boolean(search)) + Number(Boolean(statusFilter)) + Number(Boolean(roleFilter));

  useWorkbenchMotion(pageRef, { tabKey: String(listRevision) });

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const [accountResult, roleResult] = await Promise.all([
        listWarehouseAccounts({ search, status: statusFilter, roleId: roleFilter, page, pageSize: 20 }),
        canViewRoles ? listWarehouseRoles() : Promise.resolve([]),
      ]);
      if (requestId !== requestSequence.current) return;
      setAccounts(accountResult.data);
      setTotal(accountResult.pagination.total);
      setRoles(roleResult);
      setListRevision(revision => revision + 1);
    } catch (cause) {
      if (requestId !== requestSequence.current) return;
      setError(cause instanceof Error ? cause.message : '账户数据加载失败。');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [canViewRoles, page, roleFilter, search, statusFilter]);

  useEffect(() => {
    void load();
    return () => { requestSequence.current += 1; };
  }, [load]);

  const warehouseOptions = useMemo(() => warehouseSession.session?.workspaces.map(workspace => ({
    label: workspace.warehouseName,
    value: workspace.warehouseId,
  })) ?? [], [warehouseSession.session?.workspaces]);

  const applySearch = (value: string) => {
    const normalized = value.trim();
    setSearchDraft(value);
    if (page === 1 && normalized === search) {
      void load();
      return;
    }
    setPage(1);
    setSearch(normalized);
  };

  const clearFilters = () => {
    setSearchDraft('');
    setSearch('');
    setStatusFilter('');
    setRoleFilter('');
    setPage(1);
  };

  const openEditAccount = (account: WarehouseAccount) => {
    const membership = account.memberships[0];
    editForm.setFieldsValue({
      loginName: account.loginName,
      displayName: account.displayName,
      phone: account.phone ?? '',
      email: account.email ?? '',
      warehouseId: membership?.warehouseId,
      employeeNo: membership?.employeeNo ?? '',
      roleId: membership?.roleId,
    });
    setEditingAccount(account);
  };

  const confirmStatus = (account: WarehouseAccount) => {
    const disabling = account.status === 'ACTIVE';
    Modal.confirm({
      className: 'cmhub-confirm-modal',
      title: disabling ? '禁用该账户？' : '启用该账户？',
      content: disabling ? '保存后，该员工的现有登录会话会立即失效。' : '启用后，员工可使用现有凭据重新登录。',
      okText: disabling ? '确认禁用' : '确认启用',
      okButtonProps: disabling ? { status: 'danger' } : undefined,
      onOk: async () => {
        const busyKey = accountActionKey(account.id, 'status');
        setActionBusy(busyKey);
        try {
          await updateWarehouseAccount(account.id, { status: disabling ? 'DISABLED' : 'ACTIVE' });
          Message.success(disabling ? '账户已禁用' : '账户已启用');
          await load();
        } catch (cause) {
          Message.error(cause instanceof Error ? cause.message : '账户状态更新失败。');
          throw cause;
        } finally {
          setActionBusy('');
        }
      },
    });
  };

  const handleAccountMenuAction = (action: AccountMenuAction, account: WarehouseAccount) => {
    if (action === 'toggle-status') {
      confirmStatus(account);
      return;
    }
    if (action === 'unlock') {
      const busyKey = accountActionKey(account.id, action);
      setActionBusy(busyKey);
      void unlockWarehouseAccount(account.loginName)
        .then(() => Message.success('该账户的登录锁定已解除'))
        .catch(cause => Message.error(cause instanceof Error ? cause.message : '账户解锁失败。'))
        .finally(() => setActionBusy(''));
      return;
    }

    if (action === 'reset-password') {
      Modal.confirm({
        className: 'cmhub-confirm-modal',
        title: '重置该账户密码？',
        content: '现有登录会话会立即失效，并生成一个只显示一次的强随机临时密码。',
        okText: '生成临时密码',
        onOk: async () => {
          const busyKey = accountActionKey(account.id, action);
          setActionBusy(busyKey);
          try {
            const result = await resetWarehouseAccountPassword(account.id);
            showTemporaryPassword('密码已重置', account.loginName, result.temporaryPassword);
            await load();
          } catch (cause) {
            Message.error(cause instanceof Error ? cause.message : '密码重置失败。');
            throw cause;
          } finally {
            setActionBusy('');
          }
        },
      });
      return;
    }

    Modal.confirm({
      className: 'cmhub-confirm-modal',
      title: '永久删除该账户？',
      content: '员工登录凭证和个人资料会永久删除；业务操作事实仅保留匿名审计引用。此操作不可恢复。',
      okText: '永久删除',
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        const busyKey = accountActionKey(account.id, action);
        setActionBusy(busyKey);
        try {
          await deleteWarehouseAccount(account.id);
          Message.success('账户已删除');
          await load();
        } catch (cause) {
          Message.error(cause instanceof Error ? cause.message : '账户删除失败。');
          throw cause;
        } finally {
          setActionBusy('');
        }
      },
    });
  };

  return (
    <section ref={pageRef} className="cmhub-page cmhub-admin-page cmhub-accounts-page" aria-labelledby="accounts-title">
      <header className="cmhub-page-heading cmhub-accounts-heading" data-motion-enter>
        <div>
          <span className="cmhub-page-eyebrow"><Users size={15} aria-hidden="true" />权限与身份</span>
          <h1 id="accounts-title">账户管理</h1>
          <p>创建员工账号、分配岗位角色，并集中管理登录状态与安全凭据。</p>
        </div>
        {canManage && (
          <Button type="primary" size="large" icon={<Plus size={17} aria-hidden="true" />} data-motion-hover onClick={() => setCreateOpen(true)}>
            新增账户
          </Button>
        )}
      </header>

      {error && (
        <Alert
          type="error"
          content={error}
          action={<Button size="mini" onClick={() => void load()}>重试</Button>}
          data-motion-enter
        />
      )}

      <section className="cmhub-account-toolbar" aria-label="账户筛选" data-motion-enter data-refreshing={loading || undefined}>
        <div className="cmhub-account-filter-field cmhub-account-search-field">
          <label htmlFor="account-search">搜索账户</label>
          <Input.Search
            id="account-search"
            allowClear
            value={searchDraft}
            placeholder="姓名、账号、手机号或工号"
            onChange={value => {
              setSearchDraft(value);
              if (!value && search) {
                setSearch('');
                setPage(1);
              }
            }}
            onSearch={applySearch}
            aria-label="搜索账户"
          />
          <small>输入关键词后按 Enter 或点击搜索图标</small>
        </div>

        <div className="cmhub-account-filter-field">
          <label htmlFor="account-status-filter">账户状态</label>
          <Select
            id="account-status-filter"
            aria-label="按账户状态筛选"
            allowClear
            placeholder="全部状态"
            value={statusFilter || undefined}
            onChange={value => { setStatusFilter(value ?? ''); setPage(1); }}
            options={[{ label: '启用账户', value: 'ACTIVE' }, { label: '禁用账户', value: 'DISABLED' }]}
          />
        </div>

        <div className="cmhub-account-filter-field">
          <label htmlFor="account-role-filter">岗位角色</label>
          <Select
            id="account-role-filter"
            aria-label="按岗位角色筛选"
            allowClear
            placeholder="全部角色"
            value={roleFilter || undefined}
            onChange={value => { setRoleFilter(value ?? ''); setPage(1); }}
            options={roles.map(role => ({ label: role.name, value: role.id }))}
          />
        </div>

        <div className="cmhub-account-toolbar-actions">
          <Button
            className="cmhub-filter-action"
            icon={<RefreshCw size={16} aria-hidden="true" />}
            disabled={loading}
            data-refreshing={loading || undefined}
            data-motion-hover
            onClick={() => void load()}
          >
            {loading ? '正在刷新' : '刷新列表'}
          </Button>
          <Button
            type="text"
            icon={<FilterX size={15} aria-hidden="true" />}
            disabled={activeFilterCount === 0}
            onClick={clearFilters}
          >
            清除筛选
          </Button>
        </div>

        <div className="cmhub-account-filter-summary" role="status" aria-live="polite">
          <span><SlidersHorizontal size={14} aria-hidden="true" />{activeFilterCount ? `已应用 ${activeFilterCount} 项筛选` : '显示全部账户'}</span>
          <strong>{loading ? '正在同步账户列表' : `共 ${total} 个账户`}</strong>
        </div>
      </section>

      <section className="cmhub-account-table-panel" aria-labelledby="account-list-title" aria-busy={loading} data-loading={loading || undefined} data-motion-tab>
        <header>
          <div>
            <h2 id="account-list-title">员工账户</h2>
            <p>角色决定可访问的业务模块；安全操作会立即作用于该员工的登录会话。</p>
          </div>
          <span className="cmhub-account-sync-state">
            <BadgeCheck size={15} aria-hidden="true" />
            {loading ? '更新中' : '已同步'}
          </span>
        </header>

        <Table<WarehouseAccount>
          borderCell={false}
          loading={loading}
          rowKey="id"
          data={accounts}
          scroll={{ x: 1120 }}
          noDataElement={(
            <div className="cmhub-account-empty-state">
              <Empty description={activeFilterCount ? '未找到匹配的账户' : '当前还没有员工账户'} />
              {activeFilterCount > 0
                ? <Button type="text" icon={<FilterX size={15} aria-hidden="true" />} onClick={clearFilters}>清除筛选条件</Button>
                : canManage && <Button type="primary" icon={<Plus size={15} aria-hidden="true" />} onClick={() => setCreateOpen(true)}>创建第一个账户</Button>}
            </div>
          )}
          pagination={{ current: page, pageSize: 20, total, onChange: setPage, showTotal: true }}
          columns={[
            {
              title: '员工账户',
              width: 208,
              render: (_, account) => (
                <div className="cmhub-account-cell">
                  <span className="cmhub-account-avatar" aria-hidden="true">{account.displayName.trim().slice(0, 1) || 'C'}</span>
                  <span className="cmhub-account-identity">
                    <strong>{account.displayName}</strong>
                    <small>{account.loginName}</small>
                  </span>
                </div>
              ),
            },
            {
              title: '联系方式',
              width: 204,
              render: (_, account) => (
                <div className="cmhub-account-contact-cell">
                  {account.phone && <span>{account.phone}</span>}
                  {account.email && <small>{account.email}</small>}
                  {!account.phone && !account.email && <span className="cmhub-account-empty-value">未填写</span>}
                </div>
              ),
            },
            {
              title: '岗位角色',
              width: 238,
              render: (_, account) => (
                <div className="cmhub-account-role-list">
                  {account.platformRole
                    ? <Tag color="arcoblue">系统管理员</Tag>
                    : account.memberships.length
                      ? account.memberships.map(item => <Tag key={item.id}>{item.warehouseName} · {item.roleName ?? '未分配角色'}</Tag>)
                      : <Tag>未分配角色</Tag>}
                </div>
              ),
            },
            {
              title: '安全状态',
              width: 178,
              render: (_, account) => (
                <div className="cmhub-account-status-list">
                  <Tag color={account.status === 'ACTIVE' ? 'blue' : 'gray'}>{account.status === 'ACTIVE' ? '已启用' : '已禁用'}</Tag>
                  {account.passwordState === 'CHANGE_REQUIRED' && <Tag color="orange">需修改初始密码</Tag>}
                </div>
              ),
            },
            {
              title: '最近登录',
              width: 148,
              render: (_, account) => {
                const lastLogin = formatLastLogin(account.lastLoginAt);
                return lastLogin ? (
                  <time className="cmhub-account-last-login" dateTime={account.lastLoginAt ?? undefined}>
                    <span>{lastLogin.date}</span>
                    <small>{lastLogin.time}</small>
                  </time>
                ) : <span className="cmhub-account-empty-value">从未登录</span>;
              },
            },
            {
              title: '操作',
              width: 144,
              fixed: 'right',
              render: (_, account) => {
                const isCurrentAccount = account.id === warehouseSession.session?.userId;
                const rowBusy = actionBusy.startsWith(`${account.id}:`);
                return (
                  <div className="cmhub-account-row-actions">
                    {canManage && (
                      <Button
                        className="cmhub-account-row-action"
                        type="text"
                        size="small"
                        icon={<Pencil size={14} aria-hidden="true" />}
                        disabled={rowBusy}
                        aria-label={`编辑 ${account.displayName}`}
                        onClick={() => openEditAccount(account)}
                      >
                        编辑
                      </Button>
                    )}
                    {(canManage || canResetPassword) && (
                      <Dropdown
                        trigger="click"
                        position="br"
                        disabled={rowBusy}
                        droplist={(
                          <Menu
                            className="cmhub-account-action-menu"
                            onClickMenuItem={key => handleAccountMenuAction(key as AccountMenuAction, account)}
                          >
                            {canManage && (
                              <Menu.Item
                                key="toggle-status"
                                disabled={isCurrentAccount && account.status === 'ACTIVE'}
                                className={account.status === 'ACTIVE' ? 'cmhub-account-menu-danger' : 'cmhub-account-menu-success'}
                              >
                                {account.status === 'ACTIVE'
                                  ? <UserRoundX size={15} aria-hidden="true" />
                                  : <UserRoundCheck size={15} aria-hidden="true" />}
                                {account.status === 'ACTIVE' ? '禁用账户' : '启用账户'}
                              </Menu.Item>
                            )}
                            {canManage && (
                              <Menu.Item key="unlock">
                                <LockOpen size={15} aria-hidden="true" />解除登录锁定
                              </Menu.Item>
                            )}
                            {canResetPassword && (
                              <Menu.Item key="reset-password">
                                <KeyRound size={15} aria-hidden="true" />重置临时密码
                              </Menu.Item>
                            )}
                            {canManage && (
                              <Menu.Item key="delete" disabled={isCurrentAccount} className="cmhub-account-menu-danger">
                                <Trash2 size={15} aria-hidden="true" />永久删除账户
                              </Menu.Item>
                            )}
                          </Menu>
                        )}
                      >
                        <Button
                          className="cmhub-account-row-action"
                          type="text"
                          size="small"
                          icon={<MoreHorizontal size={15} aria-hidden="true" />}
                          loading={rowBusy}
                          aria-label={`${account.displayName} 的更多账户操作`}
                        >
                          更多
                        </Button>
                      </Dropdown>
                    )}
                  </div>
                );
              },
            },
          ]}
        />
      </section>

      <Modal
        className="cmhub-account-form-modal"
        title={<span className="cmhub-account-modal-title"><Plus size={18} aria-hidden="true" />新增员工账户</span>}
        visible={createOpen}
        confirmLoading={creating}
        okText="创建账户"
        cancelText="取消"
        maskClosable={false}
        onCancel={() => { if (!creating) setCreateOpen(false); }}
        onOk={() => form.submit()}
        unmountOnExit
        style={{ width: 640 }}
      >
        <div className="cmhub-account-modal-intro">
          <strong>建立员工的首个登录身份</strong>
          <span>创建成功后会生成一次性临时密码，员工首次登录时必须修改。</span>
        </div>
        <Form form={form} layout="vertical" className="cmhub-account-form" onSubmit={async values => {
          setCreating(true);
          try {
            const result = await createWarehouseAccount(values as Parameters<typeof createWarehouseAccount>[0]);
            setCreateOpen(false);
            form.resetFields();
            showTemporaryPassword('账户已创建', result.loginName, result.temporaryPassword);
            await load();
          } catch (cause) {
            Message.error(cause instanceof Error ? cause.message : '账户创建失败。');
          } finally {
            setCreating(false);
          }
        }}>
          <div className="cmhub-form-grid">
            <Form.Item label="登录账号" field="loginName" extra="建议使用姓名拼音或企业账号格式" rules={[{ required: true, message: '请输入登录账号' }]}>
              <Input maxLength={50} autoComplete="off" placeholder="例如 max.zhang" />
            </Form.Item>
            <Form.Item label="员工姓名" field="displayName" rules={[{ required: true, message: '请输入员工姓名' }]}>
              <Input maxLength={128} autoComplete="name" placeholder="填写员工常用姓名" />
            </Form.Item>
          </div>
          <div className="cmhub-form-grid">
            <Form.Item label="手机号码" field="phone"><Input type="tel" maxLength={32} autoComplete="tel" placeholder="选填" /></Form.Item>
            <Form.Item label="工作邮箱" field="email"><Input type="email" maxLength={254} autoComplete="email" placeholder="选填" /></Form.Item>
          </div>
          <div className="cmhub-form-grid cmhub-account-assignment-fields">
            <Form.Item label="所属仓库" field="warehouseId" rules={[{ required: true, message: '请选择仓库' }]}>
              <Select placeholder="选择仓库" options={warehouseOptions} />
            </Form.Item>
            <Form.Item label="员工工号" field="employeeNo"><Input maxLength={64} placeholder="选填" /></Form.Item>
            <Form.Item className="cmhub-account-assignment-role" label="初始岗位角色" field="roleId" extra="角色决定员工可查看和操作的业务模块" rules={[{ required: true, message: '请选择角色' }]}>
              <Select placeholder="选择岗位角色" options={roles.map(role => ({ label: role.name, value: role.id }))} />
            </Form.Item>
          </div>
        </Form>
      </Modal>

      <Modal
        className="cmhub-account-form-modal"
        title={<span className="cmhub-account-modal-title"><Pencil size={17} aria-hidden="true" />编辑员工账户</span>}
        visible={Boolean(editingAccount)}
        confirmLoading={editSaving}
        okText="保存修改"
        cancelText="取消"
        maskClosable={false}
        onCancel={() => {
          if (editSaving) return;
          setEditingAccount(null);
          editForm.resetFields();
        }}
        onOk={() => editForm.submit()}
        unmountOnExit
        style={{ width: 640 }}
      >
        <div className="cmhub-account-modal-intro">
          <strong>{editingAccount?.displayName ?? '员工账户'}</strong>
          <span>账号资料与岗位角色保存后立即生效。</span>
        </div>
        <Form form={editForm} layout="vertical" className="cmhub-account-form" onSubmit={async values => {
          if (!editingAccount) return;
          const input = values as {
            loginName: string; displayName: string; phone?: string; email?: string;
            warehouseId?: string; employeeNo?: string; roleId?: string;
          };
          setEditSaving(true);
          try {
            await updateWarehouseAccount(editingAccount.id, {
              loginName: input.loginName,
              displayName: input.displayName,
              phone: input.phone?.trim() || null,
              email: input.email?.trim() || null,
            });
            if (!editingAccount.platformRole && input.warehouseId && input.roleId) {
              await assignWarehouseAccountRole(editingAccount.id, {
                warehouseId: input.warehouseId,
                roleId: input.roleId,
                employeeNo: input.employeeNo?.trim() || null,
              });
            }
            setEditingAccount(null);
            editForm.resetFields();
            Message.success('账户资料与岗位角色已更新');
            await load();
          } catch (cause) {
            Message.error(cause instanceof Error ? cause.message : '账户更新失败。');
          } finally {
            setEditSaving(false);
          }
        }}>
          <div className="cmhub-form-grid">
            <Form.Item label="登录账号" field="loginName" rules={[{ required: true, message: '请输入登录账号' }]}>
              <Input maxLength={50} autoComplete="off" />
            </Form.Item>
            <Form.Item label="员工姓名" field="displayName" rules={[{ required: true, message: '请输入员工姓名' }]}>
              <Input maxLength={128} autoComplete="name" />
            </Form.Item>
          </div>
          <div className="cmhub-form-grid">
            <Form.Item label="手机号码" field="phone"><Input type="tel" maxLength={32} autoComplete="tel" placeholder="选填" /></Form.Item>
            <Form.Item label="工作邮箱" field="email"><Input type="email" maxLength={254} autoComplete="email" placeholder="选填" /></Form.Item>
          </div>
          {!editingAccount?.platformRole && (
            <div className="cmhub-form-grid cmhub-account-assignment-fields">
              <Form.Item label="所属仓库" field="warehouseId" rules={[{ required: true, message: '请选择仓库' }]}>
                <Select placeholder="选择仓库" options={warehouseOptions} />
              </Form.Item>
              <Form.Item label="员工工号" field="employeeNo"><Input maxLength={64} placeholder="选填" /></Form.Item>
              <Form.Item className="cmhub-account-assignment-role" label="岗位角色" field="roleId" rules={[{ required: true, message: '请选择角色' }]}>
                <Select placeholder="选择岗位角色" options={roles.map(role => ({ label: role.name, value: role.id }))} />
              </Form.Item>
            </div>
          )}
        </Form>
      </Modal>
    </section>
  );
}
