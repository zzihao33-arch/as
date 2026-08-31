import {
  Alert,
  Button,
  Form,
  Input,
  Message,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from '@arco-design/web-react';
import { KeyRound, LockOpen, Pencil, Plus, RefreshCw, Trash2, UserRoundCheck, UserRoundX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
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

function showTemporaryPassword(title: string, loginName: string, password: string) {
  Modal.info({
    title,
    content: (
      <div className="cmhub-secret-result">
        <Typography.Paragraph>请立即交给员工并妥善保存；关闭后系统不会再次展示。</Typography.Paragraph>
        <dl>
          <div><dt>账号</dt><dd>{loginName}</dd></div>
          <div><dt>临时密码</dt><dd className="cmhub-mono">{password}</dd></div>
        </dl>
        <Button onClick={() => void navigator.clipboard.writeText(`${loginName}\n${password}`).then(() => Message.success('账号与临时密码已复制'))}>复制登录信息</Button>
      </div>
    ),
    okText: '我已保存',
  });
}

export default function AccountsPage() {
  const warehouseSession = useWarehouseSession();
  const [accounts, setAccounts] = useState<WarehouseAccount[]>([]);
  const [roles, setRoles] = useState<WarehouseRoleView[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<WarehouseAccount | null>(null);
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const canManage = warehouseSession.hasPermission('accounts.manage');
  const canResetPassword = warehouseSession.hasPermission('accounts.reset_password');
  const canViewRoles = warehouseSession.hasPermission('roles.view');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [accountResult, roleResult] = await Promise.all([
        listWarehouseAccounts({ search, status: statusFilter, roleId: roleFilter, page, pageSize: 20 }),
        canViewRoles ? listWarehouseRoles() : Promise.resolve([]),
      ]);
      setAccounts(accountResult.data);
      setTotal(accountResult.pagination.total);
      setRoles(roleResult);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '账户数据加载失败。');
    } finally {
      setLoading(false);
    }
  }, [canViewRoles, page, roleFilter, search, statusFilter]);

  useEffect(() => { void load(); }, [load]);

  const warehouseOptions = useMemo(() => warehouseSession.session?.workspaces.map(workspace => ({
    label: workspace.warehouseName,
    value: workspace.warehouseId,
  })) ?? [], [warehouseSession.session?.workspaces]);

  const confirmStatus = (account: WarehouseAccount) => {
    const disabling = account.status === 'ACTIVE';
    Modal.confirm({
      title: disabling ? '禁用该账户？' : '启用该账户？',
      content: disabling ? '保存后该员工的现有登录会话会立即失效。' : '启用后员工可重新登录。',
      okButtonProps: disabling ? { status: 'danger' } : undefined,
      onOk: async () => {
        await updateWarehouseAccount(account.id, { status: disabling ? 'DISABLED' : 'ACTIVE' });
        await load();
      },
    });
  };

  return (
    <section className="cmhub-page cmhub-admin-page" aria-labelledby="accounts-title">
      <header className="cmhub-page-heading">
        <div>
          <h1 id="accounts-title">账户管理</h1>
          <p>创建员工账号、分配初始角色，并管理账户状态和临时密码。</p>
        </div>
        {canManage && <Button type="primary" icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>新增账户</Button>}
      </header>

      {error && <Alert type="error" content={error} action={<Button size="mini" onClick={() => void load()}>重试</Button>} />}

      <div className="cmhub-admin-toolbar">
        <Input.Search
          allowClear
          value={search}
          placeholder="搜索姓名、账号、手机号或工号"
          onChange={setSearch}
          onSearch={() => { setPage(1); void load(); }}
        />
        <Select
          allowClear
          placeholder="账户状态"
          value={statusFilter || undefined}
          onChange={value => { setStatusFilter(value ?? ''); setPage(1); }}
          options={[{ label: '启用', value: 'ACTIVE' }, { label: '禁用', value: 'DISABLED' }]}
        />
        <Select
          allowClear
          placeholder="角色"
          value={roleFilter || undefined}
          onChange={value => { setRoleFilter(value ?? ''); setPage(1); }}
          options={roles.map(role => ({ label: role.name, value: role.id }))}
        />
        <Button icon={<RefreshCw size={15} />} onClick={() => void load()}>刷新</Button>
      </div>

      <Table
        borderCell={false}
        loading={loading}
        rowKey="id"
        data={accounts}
        noDataElement="未找到匹配的账户"
        pagination={{ current: page, pageSize: 20, total, onChange: setPage, showTotal: true }}
        columns={[
          {
            title: '员工',
            render: (_, account) => (
              <div className="cmhub-account-cell">
                <strong>{account.displayName}</strong>
                <span>{account.loginName}</span>
              </div>
            ),
          },
          { title: '联系方式', render: (_, account) => account.phone || account.email || '—' },
          {
            title: '角色',
            render: (_, account) => account.platformRole
              ? <Tag color="arcoblue">系统管理员</Tag>
              : account.memberships.length
                ? account.memberships.map(item => <Tag key={item.id}>{item.warehouseName} · {item.roleName ?? '未分配角色'}</Tag>)
                : <Tag>未分配角色</Tag>,
          },
          {
            title: '状态',
            render: (_, account) => (
              <Space>
                <Tag color={account.status === 'ACTIVE' ? 'blue' : 'gray'}>{account.status === 'ACTIVE' ? '启用' : '禁用'}</Tag>
                {account.passwordState === 'CHANGE_REQUIRED' && <Tag color="orange">待修改初始密码</Tag>}
              </Space>
            ),
          },
          { title: '最近登录', render: (_, account) => account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleString() : '从未登录' },
          {
            title: '操作',
            width: 420,
            render: (_, account) => (
              <Space>
                {canManage && <Button size="small" icon={<Pencil size={14} />} onClick={() => {
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
                }}>编辑</Button>}
                {canManage && <Button
                  size="small"
                  icon={account.status === 'ACTIVE' ? <UserRoundX size={14} /> : <UserRoundCheck size={14} />}
                  disabled={account.id === warehouseSession.session?.userId && account.status === 'ACTIVE'}
                  onClick={() => confirmStatus(account)}
                >{account.status === 'ACTIVE' ? '禁用' : '启用'}</Button>}
                {canManage && <Button size="small" icon={<LockOpen size={14} />} onClick={async () => {
                  await unlockWarehouseAccount(account.loginName);
                  Message.success('该账户的登录锁定已解除');
                }}>解锁</Button>}
                {canResetPassword && <Button size="small" icon={<KeyRound size={14} />} onClick={() => {
                  Modal.confirm({
                    title: '重置密码？',
                    content: '现有登录会话会立即失效，并生成只显示一次的强随机临时密码。',
                    onOk: async () => {
                      const result = await resetWarehouseAccountPassword(account.id);
                      showTemporaryPassword('密码已重置', account.loginName, result.temporaryPassword);
                      await load();
                    },
                  });
                }}>重置密码</Button>}
                {canManage && <Button size="small" status="danger" icon={<Trash2 size={14} />} disabled={account.id === warehouseSession.session?.userId} onClick={() => {
                  Modal.confirm({
                    title: '永久删除账户？',
                    content: '员工登录凭证和个人资料会永久删除；业务操作事实仅保留匿名审计引用。此操作不可恢复。',
                    okButtonProps: { status: 'danger' },
                    onOk: async () => { await deleteWarehouseAccount(account.id); await load(); },
                  });
                }}>删除</Button>}
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title="新增员工账户"
        visible={createOpen}
        confirmLoading={creating}
        okText="创建账户"
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        unmountOnExit
      >
        <Form form={form} layout="vertical" onSubmit={async values => {
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
          <Form.Item label="登录账号" field="loginName" rules={[{ required: true, message: '请输入登录账号' }]}>
            <Input maxLength={50} placeholder="例如 max.zhang" />
          </Form.Item>
          <Form.Item label="员工姓名" field="displayName" rules={[{ required: true, message: '请输入员工姓名' }]}>
            <Input maxLength={128} />
          </Form.Item>
          <div className="cmhub-form-grid">
            <Form.Item label="手机号" field="phone"><Input maxLength={32} /></Form.Item>
            <Form.Item label="邮箱" field="email"><Input maxLength={254} /></Form.Item>
          </div>
          <div className="cmhub-form-grid">
            <Form.Item label="仓库" field="warehouseId" rules={[{ required: true, message: '请选择仓库' }]}>
              <Select options={warehouseOptions} />
            </Form.Item>
            <Form.Item label="工号" field="employeeNo"><Input maxLength={64} /></Form.Item>
          </div>
          <Form.Item label="初始角色" field="roleId" rules={[{ required: true, message: '请选择角色' }]}>
            <Select options={roles.map(role => ({ label: role.name, value: role.id }))} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="编辑员工账户"
        visible={Boolean(editingAccount)}
        okText="保存修改"
        onCancel={() => { setEditingAccount(null); editForm.resetFields(); }}
        onOk={() => editForm.submit()}
        unmountOnExit
      >
        <Form form={editForm} layout="vertical" onSubmit={async values => {
          if (!editingAccount) return;
          const input = values as {
            loginName: string; displayName: string; phone?: string; email?: string;
            warehouseId?: string; employeeNo?: string; roleId?: string;
          };
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
            Message.success('账户与角色已更新');
            await load();
          } catch (cause) {
            Message.error(cause instanceof Error ? cause.message : '账户更新失败。');
          }
        }}>
          <div className="cmhub-form-grid">
            <Form.Item label="登录账号" field="loginName" rules={[{ required: true, message: '请输入登录账号' }]}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item label="员工姓名" field="displayName" rules={[{ required: true, message: '请输入员工姓名' }]}>
              <Input maxLength={128} />
            </Form.Item>
          </div>
          <div className="cmhub-form-grid">
            <Form.Item label="手机号" field="phone"><Input maxLength={32} /></Form.Item>
            <Form.Item label="邮箱" field="email"><Input maxLength={254} /></Form.Item>
          </div>
          {!editingAccount?.platformRole && (
            <div className="cmhub-form-grid">
              <Form.Item label="仓库" field="warehouseId" rules={[{ required: true, message: '请选择仓库' }]}>
                <Select options={warehouseOptions} />
              </Form.Item>
              <Form.Item label="工号" field="employeeNo"><Input maxLength={64} /></Form.Item>
              <Form.Item label="角色" field="roleId" rules={[{ required: true, message: '请选择角色' }]}>
                <Select options={roles.map(role => ({ label: role.name, value: role.id }))} />
              </Form.Item>
            </div>
          )}
        </Form>
      </Modal>
    </section>
  );
}
