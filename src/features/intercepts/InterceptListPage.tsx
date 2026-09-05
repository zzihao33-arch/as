import { useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, DialogPlugin, Empty, Input, MessagePlugin, Select, Space, Table, Tag, Textarea, Typography, type PrimaryTableCol } from 'tdesign-react';
import type { InputRef as RefInputType } from 'tdesign-react';
import { CheckCircle2, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { getInterceptWaybillError, type InterceptRule, useInterceptRules } from './useInterceptRules';
import { useWarehouseSession } from '../session/WarehouseSessionProvider';

const formatAddedAt = (timestamp: number) => new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
}).format(timestamp);

type InterceptEntryMode = 'single' | 'batch';

export default function InterceptListPage({ embedded = false }: { embedded?: boolean }) {
  const { rules, storageStatus, lastSyncedAt, sync, addRules, removeRule } = useInterceptRules();
  const warehouseSession = useWarehouseSession();
  const canManage = warehouseSession.hasPermission('intercepts.manage');
  const [waybillInput, setWaybillInput] = useState('');
  const [entryMode, setEntryMode] = useState<InterceptEntryMode>('single');
  const [submitting, setSubmitting] = useState(false);
  const [reason, setReason] = useState('客户要求拦截');
  const [searchQuery, setSearchQuery] = useState('');
  const [reasonFilter, setReasonFilter] = useState('all');
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const inputRef = useRef<RefInputType>(null);
  const singleWaybillError = entryMode === 'single' ? getInterceptWaybillError(waybillInput) : null;
  const showWaybillError = hasAttemptedSubmit && Boolean(singleWaybillError);
  const batchWaybillCount = useMemo(() => new Set(
    waybillInput.split(/[\s,;，；]+/).map(value => value.trim().toLowerCase()).filter(Boolean)
  ).size, [waybillInput]);
  const reasonOptions = useMemo(() => [...new Set(rules.map(rule => rule.reason).filter((value): value is string => Boolean(value)))], [rules]);
  const filteredRules = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return rules.filter(rule => (
      (!normalizedQuery || rule.waybillNo.toLowerCase().includes(normalizedQuery))
      && (reasonFilter === 'all' || rule.reason === reasonFilter)
    ));
  }, [reasonFilter, rules, searchQuery]);

  const commitRule = async () => {
    setHasAttemptedSubmit(true);
    if (!waybillInput.trim()) {
      MessagePlugin.warning(entryMode === 'batch' ? '请粘贴至少一个拦截单号' : '请输入或扫描拦截单号');
      inputRef.current?.focus();
      return;
    }
    if (singleWaybillError) {
      MessagePlugin.warning(singleWaybillError);
      inputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const result = await addRules(waybillInput, 'manual', reason);
      if (!result.ok) {
        MessagePlugin.warning(result.message);
        return;
      }

      setWaybillInput('');
      setHasAttemptedSubmit(false);
      MessagePlugin.success(result.message);
    } finally {
      setSubmitting(false);
    }
  };

  const syncTitle = storageStatus === 'ready' ? '名单已同步' : storageStatus === 'loading' ? '正在同步名单' : '同步需要处理';
  const syncDetail = storageStatus === 'ready'
    ? lastSyncedAt ? `更新于 ${formatAddedAt(lastSyncedAt)}` : '云端名单已就绪'
    : storageStatus === 'loading' ? '正在获取云端最新版本' : '请重新连接云端服务';

  const columns: PrimaryTableCol<InterceptRule>[] = [
    {
      title: '拦截单号',
      colKey: 'waybillNo',
      width: 210,
      cell: ({ row }) => <Typography.Text className="cmhub-intercept-waybill">{row.waybillNo}</Typography.Text>
    },
    {
      title: '拦截原因',
      colKey: 'reason',
      width: 180,
      cell: ({ row }) => row.reason || '命中拦截名单',
    },
    {
      title: '添加时间',
      colKey: 'createdAt',
      width: 200,
      cell: ({ row }) => formatAddedAt(row.createdAt)
    },
    {
      title: '来源',
      colKey: 'source',
      width: 120,
      cell: ({ row }) => <Tag theme={row.source === 'scan' ? 'primary' : 'default'}>{row.source === 'scan' ? '扫码录入' : '手动录入'}</Tag>
    },
    {
      title: '操作',
      colKey: 'id',
      width: 96,
      cell: ({ row }) => (
        <Button disabled={!canManage} className="cmhub-intercept-delete-button" variant="text" theme="danger" size="small" onClick={() => {
          DialogPlugin.confirm({
            header: '删除拦截条目？',
            body: `删除后 ${row.waybillNo} 将不再阻止所有工作站打印`,
            confirmBtn: { content: '确认删除', theme: 'danger' },
            onConfirm: () => removeRule(row.id),
          });
        }} aria-label={`删除拦截单号 ${row.waybillNo}`} icon={<Trash2 size={15} aria-hidden="true" />}>
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
          <p>云端全局共享拦截单号，所有仓库工作站同步命中并立即阻断打印</p>
        </div>
      </div>}

      <Card className="cmhub-intercept-console" headerBordered hoverShadow aria-label="拦截名单工作台">
      <Card className="cmhub-intercept-status-surface" bordered={false} hoverShadow aria-label="拦截名单同步状态">
        <div className="cmhub-intercept-status-panel">
          <div className="cmhub-intercept-status-intro flex items-center">
            <span className="cmhub-intercept-status-icon"><CheckCircle2 size={20} aria-hidden="true" /></span>
            <div>
              <strong>全局硬拦截</strong>
              <small>名单更新后，所有授权工作站将实时阻断匹配快件</small>
            </div>
          </div>
          <div className="cmhub-intercept-status-actions flex items-center">
            <span className="cmhub-intercept-cloud-state flex items-center" data-state={storageStatus} role="status" aria-live="polite" aria-atomic="true">
              {storageStatus === 'ready'
                ? <CheckCircle2 size={16} aria-hidden="true" />
                : <RefreshCw size={16} aria-hidden="true" />}
              <span><strong>{syncTitle}</strong><small>{syncDetail}</small></span>
            </span>
            <Button
              className="cmhub-intercept-sync-button"
              loading={storageStatus === 'loading'}
              disabled={storageStatus === 'loading'}
              icon={<RefreshCw size={16} strokeWidth={1.8} aria-hidden="true" />}
              onClick={() => void sync()}
            >
              同步名单
            </Button>
          </div>
        </div>
      </Card>

      {storageStatus !== 'ready' && storageStatus !== 'loading' && (
        <Alert
          className="cmhub-intercept-storage-alert"
          theme="warning"
          message={storageStatus === 'corrupted' ? '本机拦截缓存读取异常，正在等待云端重新同步' : '无法连接云端拦截服务为避免漏掉拦截，当前扫码打印将被暂停'}
        />
      )}

      <div className="cmhub-intercept-workspace" data-can-manage={canManage}>
      {canManage && <Card className="cmhub-intercept-entry" headerBordered hoverShadow aria-labelledby="cmhub-intercept-entry-title">
        <header className="cmhub-intercept-entry-header">
          <div className="cmhub-intercept-entry-copy">
            <h2 id="cmhub-intercept-entry-title">新增拦截规则</h2>
            <p>选择录入方式并注明原因，保存后立即同步到工作站</p>
          </div>
          <div className="cmhub-intercept-mode-control" role="group" aria-label="录入方式">
            <button type="button" aria-pressed={entryMode === 'single'} disabled={submitting} onClick={() => {
              setEntryMode('single');
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }}>单条录入</button>
            <button type="button" aria-pressed={entryMode === 'batch'} disabled={submitting} onClick={() => {
              setEntryMode('batch');
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }}>扫码/批量</button>
          </div>
        </header>
        <div className="cmhub-intercept-entry-controls">
          <div className="cmhub-intercept-field">
            <label htmlFor="cmhub-intercept-waybill">{entryMode === 'batch' ? '扫码 / 批量单号' : '拦截单号'}</label>
            {entryMode === 'batch' ? (
              <Textarea
                id="cmhub-intercept-waybill"
                value={waybillInput}
                autosize={{ minRows: 4, maxRows: 7 }}
                placeholder="每行一个单号，或以空格、逗号、分号分隔"
                aria-describedby="cmhub-intercept-waybill-hint"
                aria-label="扫码或批量拦截单号"
                onChange={(value: string) => setWaybillInput(value)}
              />
            ) : (
              <Input
                ref={inputRef}
                value={waybillInput}
                placeholder="输入、粘贴或扫描单号"
                status={showWaybillError ? 'error' : undefined}
                onChange={(value) => {
                  setWaybillInput(String(value));
                  if (hasAttemptedSubmit) setHasAttemptedSubmit(true);
                }}
                onEnter={() => void commitRule()}
              />
            )}
            <small id="cmhub-intercept-waybill-hint" className={showWaybillError ? 'is-error' : undefined} role={showWaybillError ? 'alert' : undefined}>
              {showWaybillError ? singleWaybillError : entryMode === 'batch' ? (batchWaybillCount ? `已识别 ${batchWaybillCount.toLocaleString()} 条单号，保存时会自动去重和校验` : '支持扫码枪输入，或以空格、逗号、分号分隔批量粘贴') : '支持手动输入、粘贴或切换为扫码批量录入'}
            </small>
          </div>
          <div className="cmhub-intercept-field">
            <label id="cmhub-intercept-reason-label">拦截原因</label>
            <Select
              aria-labelledby="cmhub-intercept-reason-label"
              value={reason}
              onChange={(value) => setReason(String(value))}
              options={[
                { label: '客户要求拦截', value: '客户要求拦截' },
                { label: '地址异常', value: '地址异常' },
                { label: '包裹破损', value: '包裹破损' },
                { label: '需人工复核', value: '需人工复核' },
                { label: '其他原因', value: '其他原因' },
              ]}
            />
            <small>该原因会显示在命中拦截时的现场提示中</small>
          </div>
        </div>
        <footer className="cmhub-intercept-entry-footer">
          <Button className="cmhub-intercept-add-button" theme="primary" icon={<Plus size={16} strokeWidth={2} aria-hidden="true" />} loading={submitting} disabled={!waybillInput.trim() || Boolean(singleWaybillError)} onClick={() => void commitRule()}>
            加入名单
          </Button>
        </footer>
      </Card>}

      <Card className="cmhub-intercept-list-section" headerBordered hoverShadow aria-labelledby="cmhub-intercept-list-title">
        <header className="cmhub-intercept-list-header">
          <div>
            <h2 id="cmhub-intercept-list-title">当前拦截名单</h2>
            <p>按最新添加时间展示，删除前需再次确认</p>
          </div>
          <span className="cmhub-intercept-count" aria-label={`当前显示 ${filteredRules.length} 条，共 ${rules.length} 条拦截记录`}>
            {filteredRules.length === rules.length
              ? `${rules.length.toLocaleString()} 条`
              : `${filteredRules.length.toLocaleString()} / ${rules.length.toLocaleString()} 条`}
          </span>
        </header>
        {rules.length > 0 && (
          <div role="search" aria-label="筛选拦截名单">
            <Space className="cmhub-intercept-list-tools">
              <Input
                value={searchQuery}
                clearable
                prefixIcon={<Search size={15} aria-hidden="true" />}
                placeholder="搜索单号"
                onChange={(value) => setSearchQuery(String(value))}
              />
              <Select
                value={reasonFilter}
                aria-label="按拦截原因筛选"
                onChange={(value) => setReasonFilter(String(value))}
                options={[{ label: '全部原因', value: 'all' }, ...reasonOptions.map(value => ({ label: value, value }))]}
              />
            </Space>
          </div>
        )}
        {filteredRules.length ? (
          <div className="cmhub-intercept-table-region" aria-label="拦截名单结果">
            <Table<InterceptRule>
              className="cmhub-intercept-table"
              rowKey="id"
              hover
              data={filteredRules}
              columns={columns}
              tableContentWidth="700px"
              pagination={{ pageSize: 20, showPageSize: false, total: filteredRules.length }}
            />
          </div>
        ) : rules.length > 0 ? (
          <div className="cmhub-intercept-empty-state cmhub-intercept-no-results">
            <Empty description="没有符合条件的拦截单号" />
            <Button variant="text" size="small" onClick={() => { setSearchQuery(''); setReasonFilter('all'); }}>清除筛选</Button>
          </div>
        ) : (
          <div className="cmhub-intercept-empty-state">
            <Empty description="当前没有拦截单号" />
            <p>添加后，匹配快件会在扫码时立即阻断并显示拦截原因</p>
          </div>
        )}
      </Card>
      </div>
      </Card>
    </section>
  );
}
