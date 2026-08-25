import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Input, Message, Table, Tag, Typography } from '@arco-design/web-react';
import type { RefInputType } from '@arco-design/web-react/es/Input';
import { Barcode, ClipboardPlus, ShieldAlert, Trash2 } from 'lucide-react';
import { type InterceptRule, useInterceptRules } from './useInterceptRules';

const formatAddedAt = (timestamp: number) => new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
}).format(timestamp);

export default function InterceptListPage() {
  const { rules, storageStatus, addRule, removeRule } = useInterceptRules();
  const [waybillInput, setWaybillInput] = useState('');
  const [scanMode, setScanMode] = useState(false);
  const inputRef = useRef<RefInputType>(null);

  useEffect(() => {
    if (!scanMode) return undefined;
    inputRef.current?.focus();
    const timeout = window.setTimeout(() => {
      setScanMode(false);
      Message.warning('未识别到条码。');
    }, 10_000);
    return () => window.clearTimeout(timeout);
  }, [scanMode]);

  const commitRule = () => {
    const result = addRule(waybillInput, scanMode ? 'scan' : 'manual');
    if (!result.ok) {
      Message.warning(result.message);
      return;
    }

    setWaybillInput('');
    setScanMode(false);
    Message.success(scanMode ? '已通过扫码加入拦截名单。' : '已加入拦截名单。');
  };

  const columns = [
    {
      title: '拦截单号',
      dataIndex: 'waybillNo',
      render: (value: string) => <Typography.Text className="cmhub-intercept-waybill">{value}</Typography.Text>
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
        <Button className="cmhub-intercept-delete-button" type="text" status="danger" size="small" onClick={() => removeRule(id)} aria-label={`删除拦截单号 ${record.waybillNo}`}>
          <Trash2 size={15} aria-hidden="true" />
          <span>删除</span>
        </Button>
      )
    }
  ];

  return (
    <section className="cmhub-page cmhub-intercept-page" aria-labelledby="intercept-page-title">
      <div className="cmhub-page-heading">
        <div>
          <h1 id="intercept-page-title">拦截名单</h1>
          <p>本机缓存实时匹配扫描单号；命中后将立即阻断打印任务。</p>
        </div>
        <Tag color="red" bordered={false}>本地硬拦截</Tag>
      </div>

      {storageStatus !== 'ready' && (
        <Alert
          className="cmhub-intercept-storage-alert"
          type="warning"
          showIcon
          content={storageStatus === 'corrupted' ? '拦截库读取异常，当前已跳过拦截判断；请重新添加需要拦截的单号。' : '本机无法保存拦截名单，本次会话中的名单将在页面关闭后失效。'}
        />
      )}

      <Card className="cmhub-intercept-entry" bordered>
        <div className="cmhub-intercept-entry-summary">
          <div className="cmhub-intercept-entry-icon"><ShieldAlert size={22} aria-hidden="true" /></div>
          <div className="cmhub-intercept-entry-copy">
            <Typography.Title heading={5}>添加拦截单号</Typography.Title>
          </div>
        </div>
        <div className="cmhub-intercept-entry-controls">
          <Input
            ref={inputRef}
            value={waybillInput}
            maxLength={25}
            allowClear
            placeholder={scanMode ? '请扫描条码（10 秒内）' : '输入或粘贴单号'}
            onChange={setWaybillInput}
            onPressEnter={commitRule}
            aria-label="拦截单号"
          />
          <div className="cmhub-intercept-entry-actions" role="group" aria-label="拦截单号操作">
            <Button className="cmhub-intercept-scan-button" loading={scanMode} onClick={() => {
              setWaybillInput('');
              setScanMode(true);
            }}>
              <Barcode size={16} aria-hidden="true" />
              <span>扫描添加</span>
            </Button>
            <Button className="cmhub-intercept-add-button" type="primary" onClick={commitRule}>
              <ClipboardPlus size={16} aria-hidden="true" />
              <span>添加</span>
            </Button>
          </div>
        </div>
      </Card>

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
