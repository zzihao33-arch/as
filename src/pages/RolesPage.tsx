import { Alert, Button, Card, Checkbox, Col, Dialog, DialogPlugin, Empty, Form, Input, MessagePlugin, Row, Space, Tag, Textarea, Typography } from 'tdesign-react';
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
  air_pickups: '提单管理',
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
      setError(cause instanceof Error ? cause.message : '角色权限加载失败');
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
          <p>角色权限在下一次请求时即时生效，无需员工重新登录</p>
        </div>
        <Button theme="primary" icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>新建角色</Button>
      </header>
      {error && <Alert theme="error" message={error} />}
      <Row className="cmhub-role-layout" gutter={[20, 20]} aria-busy={loading}>
        <Col xs={12} xl={4}><Card className="cmhub-role-list" header="角色" headerBordered hoverShadow>
          {roles.length === 0 && !loading ? <Empty description="尚未创建角色" /> : roles.map(role => (
            <button key={role.id} className={role.id === selectedRoleId ? 'is-active' : ''} onClick={() => setSelectedRoleId(role.id)}>
              <span><ShieldCheck size={17} /><strong>{role.name}</strong></span>
              <small>{role.employeeCount} 名员工 · {role.permissions.length} 项权限</small>
            </button>
          ))}
        </Card></Col>

        <Col xs={12} xl={8}><Card
          className="cmhub-permission-editor"
          header={selectedRole ? selectedRole.name : '权限详情'}
          headerBordered
          hoverShadow
          actions={selectedRole && (
            <Space>
              <Tag>{selectedRole.kind === 'DEFAULT' ? '系统角色' : '自定义角色'}</Tag>
              <Button theme="danger" size="small" icon={<Trash2 size={14} />} onClick={() => {
                DialogPlugin.confirm({
                  header: `删除角色“${selectedRole.name}”？`,
                  body: `关联的 ${selectedRole.employeeCount} 名员工会立即失去该角色并被退出登录，直到重新分配角色`,
                  confirmBtn: { content: '删除', theme: 'danger' },
                  onConfirm: async () => {
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
              <Typography.Paragraph>{selectedRole.description || '暂无角色说明'}</Typography.Paragraph>
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
                            {permission.riskLevel === 'HIGH' && <Tag theme="warning" size="small">高风险</Tag>}
                          </Checkbox>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
              <div className="cmhub-editor-footer">
                <Button theme="primary" icon={<Save size={15} />} loading={saving} onClick={async () => {
                  setSaving(true);
                  try {
                    await updateWarehouseRole(selectedRole.id, {
                      permissions: selectedPermissions,
                      expectedVersion: selectedRole.version,
                    });
                    MessagePlugin.success('角色权限已保存并即时生效');
                    await load();
                  } catch (cause) {
                    MessagePlugin.error(cause instanceof Error ? cause.message : '权限保存失败');
                  } finally {
                    setSaving(false);
                  }
                }}>保存权限</Button>
              </div>
            </>
          )}
        </Card></Col>
      </Row>

      <Dialog header="新建角色" visible={createOpen} width={600} onClose={() => setCreateOpen(false)} onConfirm={() => form.submit()} destroyOnClose>
        <Form form={form} layout="vertical" onSubmit={async ({ fields }) => {
          try {
            const role = await createWarehouseRole(fields as { name: string; description?: string });
            setCreateOpen(false);
            form.reset();
            await load();
            setSelectedRoleId(role.id);
            MessagePlugin.success('角色已创建，可继续配置权限');
          } catch (cause) {
            MessagePlugin.error(cause instanceof Error ? cause.message : '角色创建失败');
          }
        }}>
          <Form.FormItem label="角色名称" name="name" rules={[{ required: true, message: '请输入角色名称' }]}>
            <Input maxlength={20} />
          </Form.FormItem>
          <Form.FormItem label="角色说明" name="description"><Textarea maxlength={512} /></Form.FormItem>
        </Form>
      </Dialog>
    </section>
  );
}
