import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Input, Message, Modal, Select, Table, Tag, Typography } from '@arco-design/web-react';
import type { RefInputType, RefTextAreaType } from '@arco-design/web-react/es/Input';
import { Barcode, CheckCircle2, ClipboardPlus, ListChecks, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
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
  const [submitting, setSubmitting] = useState(false);
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
    if (!waybillInput.trim()) {
      Message.warning(batchMode ? '请粘贴至少一个拦截单号。' : '请输入或扫描拦截单号。');
      (batchMode ? batchInputRef : inputRef).current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const result = await addRules(waybillInput, scanMode ? 'scan' : 'manual', reason);
      if (!result.ok) {
        Message.warning(result.message);
        return;
      }

      setWaybillInput('');
      setScanMode(false);
      Message.success(scanMode ? '已通过扫码加入拦截名单。' : result.message);
    } finally {
      setSubmitting(false);
    }
  };

  const syncTitle = storageStatus === 'ready' ? '名单已同步' : storageStatus === 'loading' ? '正在同步名单' : '同步需要处理';
  const syncDetail = storageStatus === 'ready'
    ? lastSyncedAt ? `更新于 ${formatAddedAt(lastSyncedAt)}` : '云端名单已就绪'
    : storageStatus === 'loading' ? '正在获取云端最新版本' : '请重新连接云端服务';

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
        }} aria-label={`删除拦截单号 ${record.waybillNo}`} icon={<Trash2 size={15} aria-hidden="true" />}>
          删除
        </Button>
      )
    }
  ];

  return (
    <section
      className={`cmhub-page cmhub-intercept-page${embedded ? ' is-embedded' : ''}`}
      aria-labelledby={embedded ? undefined : 'intercept-page-title'}
      aria-label={embedded ? '拦截名单管理' : undefined}
    >
      {!embedded && <div className="cmhub-page-heading">
        <div>
          <h1 id="intercept-page-title">拦截名单</h1>
          <p>云端全局共享拦截单号，所有仓库工作站同步命中并立即阻断打印。</p>
        </div>
      </div>}

      <section className="cmhub-intercept-status-panel" aria-label="拦截名单同步状态">
        <div className="cmhub-intercept-status-intro">
          <span className="cmhub-intercept-status-icon"><ShieldAlert size={20} aria-hidden="true" /></span>
          <div>
            <strong>全局硬拦截</strong>
            <small>名单更新后，所有授权工作站将实时阻断匹配快件。</small>
          </div>
        </div>
        <div className="cmhub-intercept-status-actions">
          <span className="cmhub-intercept-cloud-state" data-state={storageStatus} role="status" aria-live="polite" aria-atomic="true">
            {storageStatus === 'ready'
              ? <CheckCircle2 size={16} aria-hidden="true" />
              : <RefreshCw size={16} aria-hidden="true" />}
            <span><strong>{syncTitle}</strong><small>{syncDetail}</small></span>
          </span>
          <Button
            className="cmhub-intercept-sync-button"
            loading={storageStatus === 'loading'}
            disabled={storageStatus === 'loading'}
            icon={<RefreshCw size={15} aria-hidden="true" />}
            onClick={() => void sync()}
          >
            同步名单
          </Button>
        </div>
      </section>

      {storageStatus !== 'ready' && storageStatus !== 'loading' && (
        <Alert
          className="cmhub-intercept-storage-alert"
          type="warning"
          showIcon
          content={storageStatus === 'corrupted' ? '本机拦截缓存读取异常，正在等待云端重新同步。' : '无法连接云端拦截服务。为避免漏掉拦截，当前扫码打印将被暂停。'}
        />
      )}

      {canManage && <Card className="cmhub-intercept-entry" bordered>
        <div className="cmhub-intercept-entry-header">
          <div className="cmhub-intercept-entry-summary">
            <div className="cmhub-intercept-entry-icon"><ClipboardPlus size={20} aria-hidden="true" /></div>
            <div className="cmhub-intercept-entry-copy">
              <Typography.Title heading={5}>添加拦截单号</Typography.Title>
              <p>选择录入方式并注明原因，保存后立即同步到工作站。</p>
            </div>
          </div>
          <span className="cmhub-intercept-entry-mode" data-active={scanMode || batchMode || undefined}>
            {scanMode ? '等待扫码' : batchMode ? '批量模式' : '单条模式'}
          </span>
        </div>
        <div className="cmhub-intercept-entry-controls">
          <div className="cmhub-intercept-field">
            <label htmlFor="cmhub-intercept-waybill">{batchMode ? '批量拦截单号' : '拦截单号'}</label>
            {batchMode ? (
              <Input.TextArea
                id="cmhub-intercept-waybill"
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
                id="cmhub-intercept-waybill"
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
            <small>{batchMode ? '支持换行、逗号或分号分隔；按 Ctrl/⌘ + Enter 提交。' : scanMode ? '扫描成功后按 Enter 添加，10 秒无输入将自动退出。' : '支持手动输入、粘贴或切换为扫码录入。'}</small>
          </div>
          <div className="cmhub-intercept-field">
            <label id="cmhub-intercept-reason-label">拦截原因</label>
            <Select
              aria-labelledby="cmhub-intercept-reason-label"
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
            <small>该原因会显示在命中拦截时的现场提示中。</small>
          </div>
          <div className="cmhub-intercept-entry-actions" role="group" aria-label="拦截单号操作">
            <Button className="cmhub-intercept-scan-button" type="secondary" icon={<Barcode size={16} aria-hidden="true" />} loading={scanMode} disabled={submitting} onClick={() => {
              setWaybillInput('');
              setScanMode(true);
            }}>
              扫描添加
            </Button>
            <Button type="secondary" icon={<ClipboardPlus size={16} aria-hidden="true" />} disabled={submitting} onClick={() => {
              setScanMode(false);
              setBatchMode(current => !current);
              window.setTimeout(() => {
                if (batchMode) inputRef.current?.focus();
                else batchInputRef.current?.focus();
              }, 0);
            }}>
              {batchMode ? '单条录入' : '批量粘贴'}
            </Button>
            <Button className="cmhub-intercept-add-button" type="primary" icon={<ClipboardPlus size={16} aria-hidden="true" />} loading={submitting} disabled={!waybillInput.trim()} onClick={() => void commitRule()}>
              {batchMode ? '批量加入名单' : '加入拦截名单'}
            </Button>
          </div>
        </div>
      </Card>}

      <Card
        className="cmhub-intercept-list-card"
        title={<span className="cmhub-intercept-list-title"><ListChecks size={18} aria-hidden="true" /><span><strong>当前拦截名单</strong><small>按最新添加时间展示，删除前需再次确认。</small></span></span>}
        extra={<span className="cmhub-intercept-count" aria-label={`共 ${rules.length} 条拦截记录`}>{rules.length.toLocaleString()} 条</span>}
        bordered
      >
        {rules.length ? (
          <Table<InterceptRule>
            className="cmhub-intercept-table"
            rowKey="id"
            data={rules}
            columns={columns}
            pagination={{ pageSize: 20, sizeCanChange: false, showTotal: true }}
          />
        ) : (
          <div className="cmhub-intercept-empty-state">
            <Empty description="当前没有拦截单号" />
            <p>添加后，匹配快件会在扫码时立即阻断并显示拦截原因。</p>
            {canManage && <Button type="text" onClick={() => inputRef.current?.focus()}>添加第一条拦截单号</Button>}
          </div>
        )}
      </Card>
    </section>
  );
}
