import {
  Alert,
  Button,
  Card,
  Col,
  Dialog,
  DialogPlugin,
  Dropdown,
  Empty,
  Form,
  Input,
  MessagePlugin,
  Select,
  Space,
  Table,
  Tag,
  Row,
  type PrimaryTableCol,
} from 'tdesign-react';
import {
  AddIcon,
  CheckCircleFilledIcon,
  CheckIcon,
  DeleteIcon,
  Edit1Icon,
  FileCopyIcon,
  FilterClearIcon,
  FilterIcon,
  KeyIcon,
  MoreIcon,
  RefreshIcon,
  SearchIcon,
  UserBlockedIcon,
  UserCheckedIcon,
  UsergroupIcon,
  UserSafetyIcon,
  UserUnlockedIcon,
} from 'tdesign-icons-react';
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
      MessagePlugin.success('账号与临时密码已复制');
    } catch {
      MessagePlugin.error('自动复制失败，请手动选择并复制登录信息');
    }
  };

  return (
    <div className="cmhub-secret-result">
      <div className="cmhub-secret-notice">
        <UserSafetyIcon size={20} aria-hidden="true" />
        <div>
          <strong>此密码仅显示一次</strong>
          <p>请通过安全渠道交给员工，并确认已妥善保存后再关闭</p>
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
          theme={copied ? 'default' : 'primary'}
          icon={copied ? <CheckIcon size={16} aria-hidden="true" /> : <FileCopyIcon size={16} aria-hidden="true" />}
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
  const dialog = DialogPlugin.alert({
    className: 'cmhub-account-secret-modal',
    theme: 'success',
    header: (
      <span className="cmhub-account-secret-title">
        <CheckCircleFilledIcon size={20} aria-hidden="true" />
        {title}
      </span>
    ),
    body: <TemporaryPasswordResult loginName={loginName} password={password} />,
    confirmBtn: '我已安全保存',
    closeBtn: false,
    closeOnOverlayClick: false,
    closeOnEscKeydown: false,
    width: 520,
    onConfirm: () => dialog.destroy(),
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
      setError(cause instanceof Error ? cause.message : '账户数据加载失败');
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
    const dialog = DialogPlugin.confirm({
      className: 'cmhub-confirm-modal',
      header: disabling ? '禁用该账户？' : '启用该账户？',
      body: disabling ? '保存后，该员工的现有登录会话会立即失效' : '启用后，员工可使用现有凭据重新登录',
      confirmBtn: disabling ? { content: '确认禁用', theme: 'danger' } : '确认启用',
      onClose: () => dialog.destroy(),
      onConfirm: async () => {
        const busyKey = accountActionKey(account.id, 'status');
        setActionBusy(busyKey);
        dialog.setConfirmLoading(true);
        try {
          await updateWarehouseAccount(account.id, { status: disabling ? 'DISABLED' : 'ACTIVE' });
          MessagePlugin.success(disabling ? '账户已禁用' : '账户已启用');
          await load();
          dialog.destroy();
        } catch (cause) {
          MessagePlugin.error(cause instanceof Error ? cause.message : '账户状态更新失败');
        } finally {
          setActionBusy('');
          dialog.setConfirmLoading(false);
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
        .then(() => MessagePlugin.success('该账户的登录锁定已解除'))
        .catch(cause => MessagePlugin.error(cause instanceof Error ? cause.message : '账户解锁失败'))
        .finally(() => setActionBusy(''));
      return;
    }

    if (action === 'reset-password') {
      const dialog = DialogPlugin.confirm({
        className: 'cmhub-confirm-modal',
        header: '重置该账户密码？',
        body: '现有登录会话会立即失效，并生成一个只显示一次的强随机临时密码',
        confirmBtn: '生成临时密码',
        onClose: () => dialog.destroy(),
        onConfirm: async () => {
          const busyKey = accountActionKey(account.id, action);
          setActionBusy(busyKey);
          dialog.setConfirmLoading(true);
          try {
            const result = await resetWarehouseAccountPassword(account.id);
            dialog.destroy();
            showTemporaryPassword('密码已重置', account.loginName, result.temporaryPassword);
            await load();
          } catch (cause) {
            MessagePlugin.error(cause instanceof Error ? cause.message : '密码重置失败');
          } finally {
            setActionBusy('');
            dialog.setConfirmLoading(false);
          }
        },
      });
      return;
    }

    const dialog = DialogPlugin.confirm({
      className: 'cmhub-confirm-modal',
      header: '永久删除该账户？',
      body: '员工登录凭证和个人资料会永久删除；业务操作事实仅保留匿名审计引用此操作不可恢复',
      confirmBtn: { content: '永久删除', theme: 'danger' },
      onClose: () => dialog.destroy(),
      onConfirm: async () => {
        const busyKey = accountActionKey(account.id, action);
        setActionBusy(busyKey);
        dialog.setConfirmLoading(true);
        try {
          await deleteWarehouseAccount(account.id);
          MessagePlugin.success('账户已删除');
          await load();
          dialog.destroy();
        } catch (cause) {
          MessagePlugin.error(cause instanceof Error ? cause.message : '账户删除失败');
        } finally {
          setActionBusy('');
          dialog.setConfirmLoading(false);
        }
      },
    });
  };

  return (
    <section ref={pageRef} className="cmhub-page cmhub-admin-page cmhub-accounts-page" aria-labelledby="accounts-title">
      <header className="cmhub-page-heading cmhub-accounts-heading" data-motion-enter>
        <div>
          <span className="cmhub-page-eyebrow"><UsergroupIcon size={15} aria-hidden="true" />权限与身份</span>
          <h1 id="accounts-title">账户管理</h1>
          <p>创建员工账号、分配岗位角色，并集中管理登录状态与安全凭据</p>
        </div>
        {canManage && (
          <Button theme="primary" size="large" icon={<AddIcon size={17} aria-hidden="true" />} data-motion-hover onClick={() => setCreateOpen(true)}>
            新增账户
          </Button>
        )}
      </header>

      {error && (
        <Alert
          theme="error"
          message={error}
          operation={<Button size="small" onClick={() => void load()}>重试</Button>}
          data-motion-enter
        />
      )}

      <Card className="cmhub-account-toolbar" headerBordered hoverShadow aria-label="账户筛选" data-motion-enter data-refreshing={loading || undefined}>
        <Row className="cmhub-account-filter-grid" gutter={[16, 16]}>
        <Col span={8} xs={12} md={8}><div className="cmhub-account-filter-field cmhub-account-search-field">
          <label>搜索账户</label>
          <Input
            clearable
            value={searchDraft}
            placeholder="姓名、账号、手机号或工号"
            onChange={value => {
              setSearchDraft(value);
              if (!value && search) {
                setSearch('');
                setPage(1);
              }
            }}
            onEnter={applySearch}
            suffix={<Button variant="text" shape="square" icon={<SearchIcon size={16} aria-hidden="true" />} aria-label="搜索账户" onClick={() => applySearch(searchDraft)} />}
          />
          <small>输入关键词后按 Enter 或点击搜索图标</small>
        </div></Col>

        <Col span={6} xs={12} md={6}><div className="cmhub-account-filter-field">
          <label>账户状态</label>
          <Select
            clearable
            placeholder="全部状态"
            value={statusFilter || undefined}
            onChange={value => { setStatusFilter(String(value ?? '')); setPage(1); }}
            options={[{ label: '启用账户', value: 'ACTIVE' }, { label: '禁用账户', value: 'DISABLED' }]}
          />
        </div></Col>

        <Col span={6} xs={12} md={6}><div className="cmhub-account-filter-field">
          <label>岗位角色</label>
          <Select
            clearable
            placeholder="全部角色"
            value={roleFilter || undefined}
            onChange={value => { setRoleFilter(String(value ?? '')); setPage(1); }}
            options={roles.map(role => ({ label: role.name, value: role.id }))}
          />
        </div></Col>

        <Col span={4} xs={12} md={4}><Space className="cmhub-account-toolbar-actions" size={12}>
          <Button
            className="cmhub-filter-action"
            icon={<RefreshIcon size={16} aria-hidden="true" />}
            disabled={loading}
            data-refreshing={loading || undefined}
            data-motion-hover
            onClick={() => void load()}
          >
            {loading ? '正在刷新' : '刷新列表'}
          </Button>
          <Button
            variant="text"
            icon={<FilterClearIcon size={15} aria-hidden="true" />}
            disabled={activeFilterCount === 0}
            onClick={clearFilters}
          >
            清除筛选
          </Button>
        </Space></Col>

        <Col span={24}><div className="cmhub-account-filter-summary" role="status" aria-live="polite">
          <span><FilterIcon size={14} aria-hidden="true" />{activeFilterCount ? `已应用 ${activeFilterCount} 项筛选` : '显示全部账户'}</span>
          <strong>{loading ? '正在同步账户列表' : `共 ${total} 个账户`}</strong>
        </div></Col>
        </Row>
      </Card>

      <Card className="cmhub-account-table-panel" headerBordered hoverShadow aria-labelledby="account-list-title" aria-busy={loading} data-loading={loading || undefined} data-motion-tab>
        <header>
          <div>
            <h2 id="account-list-title">员工账户</h2>
            <p>角色决定可访问的业务模块；安全操作会立即作用于该员工的登录会话</p>
          </div>
          <span className="cmhub-account-sync-state">
            <CheckCircleFilledIcon size={15} aria-hidden="true" />
            {loading ? '更新中' : '已同步'}
          </span>
        </header>

        <Table<WarehouseAccount>
          bordered={false}
          loading={loading}
          hover
          rowKey="id"
          data={accounts}
          disableDataPage
          tableContentWidth="1120px"
          empty={(
            <div className="cmhub-account-empty-state">
              <Empty description={activeFilterCount ? '未找到匹配的账户' : '当前还没有员工账户'} />
              {activeFilterCount > 0
                ? <Button variant="text" icon={<FilterClearIcon size={15} aria-hidden="true" />} onClick={clearFilters}>清除筛选条件</Button>
                : canManage && <Button theme="primary" icon={<AddIcon size={15} aria-hidden="true" />} onClick={() => setCreateOpen(true)}>创建第一个账户</Button>}
            </div>
          )}
          pagination={{ current: page, pageSize: 20, total, showPageSize: false, totalContent: `共 ${total} 个账户`, onChange: pageInfo => setPage(pageInfo.current) }}
          columns={[
            {
              colKey: 'identity',
              title: '员工账户',
              width: 208,
              cell: ({ row: account }) => (
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
              colKey: 'contact',
              title: '联系方式',
              width: 204,
              cell: ({ row: account }) => (
                <div className="cmhub-account-contact-cell">
                  {account.phone && <span>{account.phone}</span>}
                  {account.email && <small>{account.email}</small>}
                  {!account.phone && !account.email && <span className="cmhub-account-empty-value">未填写</span>}
                </div>
              ),
            },
            {
              colKey: 'role',
              title: '岗位角色',
              width: 238,
              cell: ({ row: account }) => (
                <div className="cmhub-account-role-list">
                  {account.platformRole
                    ? <Tag theme="primary" variant="light">系统管理员</Tag>
                    : account.memberships.length
                      ? account.memberships.map(item => <Tag key={item.id} theme="primary" variant="light">{item.warehouseName} · {item.roleName ?? '未分配角色'}</Tag>)
                      : <Tag variant="light">未分配角色</Tag>}
                </div>
              ),
            },
            {
              colKey: 'status',
              title: '安全状态',
              width: 178,
              cell: ({ row: account }) => (
                <div className="cmhub-account-status-list">
                  <Tag theme={account.status === 'ACTIVE' ? 'success' : 'default'} variant="light">{account.status === 'ACTIVE' ? '已启用' : '已禁用'}</Tag>
                  {account.passwordState === 'CHANGE_REQUIRED' && <Tag theme="warning" variant="light">需修改初始密码</Tag>}
                </div>
              ),
            },
            {
              colKey: 'lastLogin',
              title: '最近登录',
              width: 148,
              cell: ({ row: account }) => {
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
              colKey: 'actions',
              title: '操作',
              width: 144,
              fixed: 'right',
              cell: ({ row: account }) => {
                const isCurrentAccount = account.id === warehouseSession.session?.userId;
                const rowBusy = actionBusy.startsWith(`${account.id}:`);
                return (
                  <div className="cmhub-account-row-actions">
                    {canManage && (
                      <Button
                        className="cmhub-account-row-action"
                        variant="text"
                        size="small"
                        icon={<Edit1Icon size={14} aria-hidden="true" />}
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
                        placement="bottom-right"
                        disabled={rowBusy}
                        options={[
                          ...(canManage ? [{
                            value: 'toggle-status',
                            content: account.status === 'ACTIVE' ? '禁用账户' : '启用账户',
                            prefixIcon: account.status === 'ACTIVE' ? <UserBlockedIcon size={15} /> : <UserCheckedIcon size={15} />,
                            disabled: isCurrentAccount && account.status === 'ACTIVE',
                            theme: account.status === 'ACTIVE' ? 'error' as const : 'success' as const,
                          }] : []),
                          ...(canManage ? [{ value: 'unlock', content: '解除登录锁定', prefixIcon: <UserUnlockedIcon size={15} /> }] : []),
                          ...(canResetPassword ? [{ value: 'reset-password', content: '重置临时密码', prefixIcon: <KeyIcon size={15} /> }] : []),
                          ...(canManage ? [{ value: 'delete', content: '永久删除账户', prefixIcon: <DeleteIcon size={15} />, disabled: isCurrentAccount, theme: 'error' as const }] : []),
                        ]}
                        onClick={option => handleAccountMenuAction(option.value as AccountMenuAction, account)}
                      >
                        <Button
                          className="cmhub-account-row-action"
                          variant="text"
                          size="small"
                          icon={<MoreIcon size={15} aria-hidden="true" />}
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
          ] satisfies PrimaryTableCol<WarehouseAccount>[]}
        />
      </Card>

      <Dialog
        className="cmhub-account-form-modal"
        header={<span className="cmhub-account-modal-title"><AddIcon size={18} aria-hidden="true" />新增员工账户</span>}
        visible={createOpen}
        confirmLoading={creating}
        confirmBtn="创建账户"
        cancelBtn="取消"
        closeOnOverlayClick={false}
        onClose={() => { if (!creating) setCreateOpen(false); }}
        onConfirm={() => form.submit()}
        destroyOnClose
        width={600}
      >
        <div className="cmhub-account-modal-intro">
          <strong>建立员工的首个登录身份</strong>
          <span>创建成功后会生成一次性临时密码，员工首次登录时必须修改</span>
        </div>
        <Form form={form} layout="vertical" className="cmhub-account-form" onSubmit={async ({ fields, validateResult }) => {
          if (validateResult !== true) return;
          setCreating(true);
          try {
            const result = await createWarehouseAccount(fields as Parameters<typeof createWarehouseAccount>[0]);
            setCreateOpen(false);
            form.reset();
            showTemporaryPassword('账户已创建', result.loginName, result.temporaryPassword);
            await load();
          } catch (cause) {
            MessagePlugin.error(cause instanceof Error ? cause.message : '账户创建失败');
          } finally {
            setCreating(false);
          }
        }}>
          <div className="cmhub-form-grid">
            <Form.FormItem label="登录账号" name="loginName" help="建议使用姓名拼音或企业账号格式" rules={[{ required: true, message: '请输入登录账号' }]}>
              <Input maxlength={50} autocomplete="off" placeholder="例如 max.zhang" />
            </Form.FormItem>
            <Form.FormItem label="员工姓名" name="displayName" rules={[{ required: true, message: '请输入员工姓名' }]}>
              <Input maxlength={128} autocomplete="name" placeholder="填写员工常用姓名" />
            </Form.FormItem>
          </div>
          <div className="cmhub-form-grid">
            <Form.FormItem label="手机号码" name="phone"><Input type="tel" maxlength={32} autocomplete="tel" placeholder="选填" /></Form.FormItem>
            <Form.FormItem label="工作邮箱" name="email" rules={[{ email: true, message: '请输入有效的工作邮箱' }]}><Input maxlength={254} autocomplete="email" placeholder="选填" /></Form.FormItem>
          </div>
          <div className="cmhub-form-grid cmhub-account-assignment-fields">
            <Form.FormItem label="所属仓库" name="warehouseId" rules={[{ required: true, message: '请选择仓库' }]}>
              <Select placeholder="选择仓库" options={warehouseOptions} />
            </Form.FormItem>
            <Form.FormItem label="员工工号" name="employeeNo"><Input maxlength={64} placeholder="选填" /></Form.FormItem>
            <Form.FormItem className="cmhub-account-assignment-role" label="初始岗位角色" name="roleId" help="角色决定员工可查看和操作的业务模块" rules={[{ required: true, message: '请选择角色' }]}>
              <Select placeholder="选择岗位角色" options={roles.map(role => ({ label: role.name, value: role.id }))} />
            </Form.FormItem>
          </div>
        </Form>
      </Dialog>

      <Dialog
        className="cmhub-account-form-modal"
        header={<span className="cmhub-account-modal-title"><Edit1Icon size={17} aria-hidden="true" />编辑员工账户</span>}
        visible={Boolean(editingAccount)}
        confirmLoading={editSaving}
        confirmBtn="保存修改"
        cancelBtn="取消"
        closeOnOverlayClick={false}
        onClose={() => {
          if (editSaving) return;
          setEditingAccount(null);
          editForm.reset();
        }}
        onConfirm={() => editForm.submit()}
        destroyOnClose
        width={600}
      >
        <div className="cmhub-account-modal-intro">
          <strong>{editingAccount?.displayName ?? '员工账户'}</strong>
          <span>账号资料与岗位角色保存后立即生效</span>
        </div>
        <Form form={editForm} layout="vertical" className="cmhub-account-form" onSubmit={async ({ fields, validateResult }) => {
          if (validateResult !== true) return;
          if (!editingAccount) return;
          const input = fields as {
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
            editForm.reset();
            MessagePlugin.success('账户资料与岗位角色已更新');
            await load();
          } catch (cause) {
            MessagePlugin.error(cause instanceof Error ? cause.message : '账户更新失败');
          } finally {
            setEditSaving(false);
          }
        }}>
          <div className="cmhub-form-grid">
            <Form.FormItem label="登录账号" name="loginName" rules={[{ required: true, message: '请输入登录账号' }]}>
              <Input maxlength={50} autocomplete="off" />
            </Form.FormItem>
            <Form.FormItem label="员工姓名" name="displayName" rules={[{ required: true, message: '请输入员工姓名' }]}>
              <Input maxlength={128} autocomplete="name" />
            </Form.FormItem>
          </div>
          <div className="cmhub-form-grid">
            <Form.FormItem label="手机号码" name="phone"><Input type="tel" maxlength={32} autocomplete="tel" placeholder="选填" /></Form.FormItem>
            <Form.FormItem label="工作邮箱" name="email" rules={[{ email: true, message: '请输入有效的工作邮箱' }]}><Input maxlength={254} autocomplete="email" placeholder="选填" /></Form.FormItem>
          </div>
          {!editingAccount?.platformRole && (
            <div className="cmhub-form-grid cmhub-account-assignment-fields">
              <Form.FormItem label="所属仓库" name="warehouseId" rules={[{ required: true, message: '请选择仓库' }]}>
                <Select placeholder="选择仓库" options={warehouseOptions} />
              </Form.FormItem>
              <Form.FormItem label="员工工号" name="employeeNo"><Input maxlength={64} placeholder="选填" /></Form.FormItem>
              <Form.FormItem className="cmhub-account-assignment-role" label="岗位角色" name="roleId" rules={[{ required: true, message: '请选择角色' }]}>
                <Select placeholder="选择岗位角色" options={roles.map(role => ({ label: role.name, value: role.id }))} />
              </Form.FormItem>
            </div>
          )}
        </Form>
      </Dialog>
    </section>
  );
}
