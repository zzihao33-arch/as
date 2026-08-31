import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Input, Message, Modal, Select, Table, Tag, Typography } from '@arco-design/web-react';
import type { RefInputType, RefTextAreaType } from '@arco-design/web-react/es/Input';
import { Barcode, ClipboardPlus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { type InterceptRule, useInterceptRules } from './useInterceptRules';
import { useWarehouseSession } from '../session/WarehouseSessionProvider';

const formatAddedAt = (timestamp: number) => new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
}).format(timestamp);

export default function InterceptListPage({ embedded = false }: { embedded?: boolean }) {
  const { rules, storageStatus, lastSyncedAt, sync, addRules, removeRule } = useInterceptRules();
  const warehouseSession = useWarehouseSession();
  const canManage = warehouseSession.hasPermission('intercepts.manage');
  const [waybillInput, setWaybillInput] = useState('');
  const [scanMode, setScanMode] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [reason, setReason] = useState('客户要求拦截');
  const inputRef = useRef<RefInputType>(null);
  const batchInputRef = useRef<RefTextAreaType>(null);

  useEffect(() => {
    if (!scanMode) return undefined;
    setBatchMode(false);
    inputRef.current?.focus();
    const timeout = window.setTimeout(() => {
      setScanMode(false);
      Message.warning('未识别到条码。');
    }, 10_000);
    return () => window.clearTimeout(timeout);
  }, [scanMode]);

  const commitRule = async () => {
    const result = await addRules(waybillInput, scanMode ? 'scan' : 'manual', reason);
    if (!result.ok) {
      Message.warning(result.message);
      return;
    }

    setWaybillInput('');
    setScanMode(false);
    Message.success(scanMode ? '已通过扫码加入拦截名单。' : result.message);
  };

  const columns = [
    {
      title: '拦截单号',
      dataIndex: 'waybillNo',
      render: (value: string) => <Typography.Text className="cmhub-intercept-waybill">{value}</Typography.Text>
    },
    {
      title: '拦截原因',
      dataIndex: 'reason',
      render: (value: string | undefined) => value || '命中拦截名单',
    },
    {
      title: '添加时间',
      dataIndex: 'createdAt',
      width: 200,
      render: (value: number) => formatAddedAt(value)
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 120,
      render: (value: InterceptRule['source']) => <Tag color={value === 'scan' ? 'arcoblue' : 'gray'}>{value === 'scan' ? '扫码录入' : '手动录入'}</Tag>
    },
    {
      title: '操作',
      dataIndex: 'id',
      width: 96,
      render: (id: string, record: InterceptRule) => (
        <Button disabled={!canManage} className="cmhub-intercept-delete-button" type="text" status="danger" size="small" onClick={() => {
          Modal.confirm({
            title: '删除拦截条目？',
            content: `删除后 ${record.waybillNo} 将不再阻止所有工作站打印。`,
            okText: '确认删除',
            okButtonProps: { status: 'danger' },
            onOk: () => removeRule(id),
          });
        }} aria-label={`删除拦截单号 ${record.waybillNo}`}>
          <Trash2 size={15} aria-hidden="true" />
          <span>删除</span>
        </Button>
      )
    }
  ];

  return (
    <section className={`cmhub-page cmhub-intercept-page${embedded ? ' is-embedded' : ''}`} aria-labelledby="intercept-page-title">
      <div className="cmhub-page-heading">
        <div>
          <h1 id="intercept-page-title">{embedded ? '全局拦截规则' : '拦截名单'}</h1>
          <p>云端全局共享拦截单号，所有仓库工作站同步命中并立即阻断打印。</p>
        </div>
        <div className="cmhub-intercept-sync-state">
          <Tag color="red" bordered={false}>全局硬拦截</Tag>
          <Tag color={storageStatus === 'ready' ? 'arcoblue' : 'orange'}>
            {storageStatus === 'ready'
              ? `已同步 ${lastSyncedAt ? formatAddedAt(lastSyncedAt) : ''}`
              : storageStatus === 'loading' ? '正在同步' : '同步异常'}
          </Tag>
          <Button size="small" icon={<RefreshCw size={14} />} onClick={() => void sync()}>立即同步</Button>
        </div>
      </div>

      {storageStatus !== 'ready' && storageStatus !== 'loading' && (
        <Alert
          className="cmhub-intercept-storage-alert"
          type="warning"
          showIcon
          content={storageStatus === 'corrupted' ? '本机拦截缓存读取异常，正在等待云端重新同步。' : '无法连接云端拦截服务。为避免漏掉拦截，当前扫码打印将被暂停。'}
        />
      )}

      {canManage && <Card className="cmhub-intercept-entry" bordered>
        <div className="cmhub-intercept-entry-summary">
          <div className="cmhub-intercept-entry-icon"><ShieldAlert size={22} aria-hidden="true" /></div>
          <div className="cmhub-intercept-entry-copy">
            <Typography.Title heading={5}>添加拦截单号</Typography.Title>
          </div>
        </div>
        <div className="cmhub-intercept-entry-controls">
          {batchMode ? (
            <Input.TextArea
              ref={batchInputRef}
              value={waybillInput}
              autoSize={{ minRows: 2, maxRows: 5 }}
              placeholder="每行、逗号或分号分隔一个单号"
              onChange={setWaybillInput}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void commitRule();
                }
              }}
              aria-label="批量拦截单号"
            />
          ) : (
            <Input
              ref={inputRef}
              value={waybillInput}
              maxLength={128}
              allowClear
              placeholder={scanMode ? '请扫描条码（10 秒内）' : '输入或粘贴单号'}
              onChange={setWaybillInput}
              onPressEnter={() => void commitRule()}
              aria-label="拦截单号"
            />
          )}
          <Select
            aria-label="拦截原因"
            value={reason}
            onChange={setReason}
            options={[
              { label: '客户要求拦截', value: '客户要求拦截' },
              { label: '地址异常', value: '地址异常' },
              { label: '包裹破损', value: '包裹破损' },
              { label: '需人工复核', value: '需人工复核' },
              { label: '其他原因', value: '其他原因' },
            ]}
          />
          <div className="cmhub-intercept-entry-actions" role="group" aria-label="拦截单号操作">
            <Button className="cmhub-intercept-scan-button" loading={scanMode} onClick={() => {
              setWaybillInput('');
              setScanMode(true);
            }}>
              <Barcode size={16} aria-hidden="true" />
              <span>扫描添加</span>
            </Button>
            <Button onClick={() => {
              setScanMode(false);
              setBatchMode(current => !current);
              window.setTimeout(() => {
                if (batchMode) inputRef.current?.focus();
                else batchInputRef.current?.focus();
              }, 0);
            }}>
              <ClipboardPlus size={16} aria-hidden="true" />
              <span>{batchMode ? '单条录入' : '批量粘贴'}</span>
            </Button>
            <Button className="cmhub-intercept-add-button" type="primary" onClick={() => void commitRule()}>
              <ClipboardPlus size={16} aria-hidden="true" />
              <span>{batchMode ? '批量添加' : '添加'}</span>
            </Button>
          </div>
        </div>
      </Card>}

      <Card className="cmhub-intercept-list-card" title={`拦截列表 · ${rules.length} 条`} bordered>
        {rules.length ? (
          <Table<InterceptRule>
            className="cmhub-intercept-table"
            rowKey="id"
            data={rules}
            columns={columns}
            pagination={{ pageSize: 20, sizeCanChange: false, showTotal: true }}
          />
        ) : (
          <Empty description="尚未添加拦截单号。需要拦截的快件将在扫码时立即阻断。" />
        )}
      </Card>
    </section>
  );
}
