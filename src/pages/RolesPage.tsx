import { Alert, Button, Card, Checkbox, Empty, Form, Input, Message, Modal, Space, Tag, Typography } from '@arco-design/web-react';
import { Plus, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createWarehouseRole,
  deleteWarehouseRole,
  listWarehousePermissions,
  listWarehouseRoles,
  updateWarehouseRole,
  type WarehousePermissionView,
  type WarehouseRoleView,
} from '../features/session/warehouseApi';

const permissionModuleLabels: Record<string, string> = {
  air_pickups: '空提管理',
};

export default function RolesPage() {
  const [roles, setRoles] = useState<WarehouseRoleView[]>([]);
  const [permissions, setPermissions] = useState<WarehousePermissionView[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [roleResult, permissionResult] = await Promise.all([listWarehouseRoles(), listWarehousePermissions()]);
      setRoles(roleResult);
      setPermissions(permissionResult);
      setSelectedRoleId(current => current || roleResult[0]?.id || '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '角色权限加载失败。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const selectedRole = roles.find(role => role.id === selectedRoleId) ?? null;
  useEffect(() => { setSelectedPermissions(selectedRole?.permissions ?? []); }, [selectedRole]);

  const groupedPermissions = useMemo(() => permissions.reduce<Record<string, WarehousePermissionView[]>>((groups, permission) => {
    (groups[permission.module] ??= []).push(permission);
    return groups;
  }, {}), [permissions]);

  return (
    <section className="cmhub-page cmhub-admin-page" aria-labelledby="roles-title">
      <header className="cmhub-page-heading">
        <div>
          <h1 id="roles-title">角色配置</h1>
          <p>角色权限在下一次请求时即时生效，无需员工重新登录。</p>
        </div>
        <Button type="primary" icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>新建角色</Button>
      </header>
      {error && <Alert type="error" content={error} />}
      <div className="cmhub-role-layout" aria-busy={loading}>
        <Card className="cmhub-role-list" title="角色">
          {roles.length === 0 && !loading ? <Empty description="尚未创建角色" /> : roles.map(role => (
            <button key={role.id} className={role.id === selectedRoleId ? 'is-active' : ''} onClick={() => setSelectedRoleId(role.id)}>
              <span><ShieldCheck size={17} /><strong>{role.name}</strong></span>
              <small>{role.employeeCount} 名员工 · {role.permissions.length} 项权限</small>
            </button>
          ))}
        </Card>

        <Card
          className="cmhub-permission-editor"
          title={selectedRole ? selectedRole.name : '权限详情'}
          extra={selectedRole && (
            <Space>
              <Tag>{selectedRole.kind === 'DEFAULT' ? '系统角色' : '自定义角色'}</Tag>
              <Button status="danger" size="small" icon={<Trash2 size={14} />} onClick={() => {
                Modal.confirm({
                  title: `删除角色“${selectedRole.name}”？`,
                  content: `关联的 ${selectedRole.employeeCount} 名员工会立即失去该角色并被退出登录，直到重新分配角色。`,
                  okButtonProps: { status: 'danger' },
                  onOk: async () => {
                    await deleteWarehouseRole(selectedRole.id);
                    setSelectedRoleId('');
                    await load();
                  },
                });
              }}>删除</Button>
            </Space>
          )}
        >
          {!selectedRole ? <Empty description="请选择角色" /> : (
            <>
              <Typography.Paragraph>{selectedRole.description || '暂无角色说明。'}</Typography.Paragraph>
              <div className="cmhub-permission-groups">
                {Object.entries(groupedPermissions).map(([module, items]) => {
                  const itemCodes = items.map(item => item.code);
                  const checkedCount = itemCodes.filter(code => selectedPermissions.includes(code)).length;
                  return (
                    <section key={module}>
                      <Checkbox
                        checked={checkedCount === itemCodes.length}
                        indeterminate={checkedCount > 0 && checkedCount < itemCodes.length}
                        onChange={checked => setSelectedPermissions(current => checked
                          ? [...new Set([...current, ...itemCodes])]
                          : current.filter(code => !itemCodes.includes(code)))}
                      >{permissionModuleLabels[module] ?? module}</Checkbox>
                      <div>
                        {items.map(permission => (
                          <Checkbox
                            key={permission.code}
                            checked={selectedPermissions.includes(permission.code)}
                            onChange={checked => setSelectedPermissions(current => checked
                              ? [...current, permission.code]
                              : current.filter(code => code !== permission.code))}
                          >
                            {permission.name}
                            {permission.riskLevel === 'HIGH' && <Tag color="orange" size="small">高风险</Tag>}
                          </Checkbox>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
              <div className="cmhub-editor-footer">
                <Button type="primary" icon={<Save size={15} />} loading={saving} onClick={async () => {
                  setSaving(true);
                  try {
                    await updateWarehouseRole(selectedRole.id, {
                      permissions: selectedPermissions,
                      expectedVersion: selectedRole.version,
                    });
                    Message.success('角色权限已保存并即时生效');
                    await load();
                  } catch (cause) {
                    Message.error(cause instanceof Error ? cause.message : '权限保存失败。');
                  } finally {
                    setSaving(false);
                  }
                }}>保存权限</Button>
              </div>
            </>
          )}
        </Card>
      </div>

      <Modal title="新建角色" visible={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} unmountOnExit>
        <Form form={form} layout="vertical" onSubmit={async values => {
          try {
            const role = await createWarehouseRole(values as { name: string; description?: string });
            setCreateOpen(false);
            form.resetFields();
            await load();
            setSelectedRoleId(role.id);
          } catch (cause) {
            Message.error(cause instanceof Error ? cause.message : '角色创建失败。');
          }
        }}>
          <Form.Item label="角色名称" field="name" rules={[{ required: true, message: '请输入角色名称' }]}>
            <Input maxLength={20} />
          </Form.Item>
          <Form.Item label="角色说明" field="description"><Input.TextArea maxLength={512} /></Form.Item>
        </Form>
      </Modal>
    </section>
  );
}
