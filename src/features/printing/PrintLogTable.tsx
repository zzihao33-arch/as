import { memo } from 'react';
import { Clock3 } from 'lucide-react';
import { Tag } from 'tdesign-react';
import type { PrintLog } from './printingTypes';

interface PrintLogTableProps {
  logs: Array<PrintLog & { rowNumber: number }>;
  latestLogId: string | null;
}

function PrintLogTable({ logs, latestLogId }: PrintLogTableProps) {
  if (logs.length === 0) {
    return (
      <div className="cmhub-log-empty-state" role="status">
        <Clock3 size={22} aria-hidden="true" />
        <div><strong>暂无匹配的记录</strong><span>调整筛选条件，或完成一次新的操作后在这里查看结果</span></div>
      </div>
    );
  }

  return (
    <div className="cmhub-log-list" role="list" aria-label="操作日志记录">
      {logs.map(record => {
        const isSuccess = record.status === 'success';
        const isTimeout = record.outcome === 'TIMEOUT';
        const visualStatus = isTimeout ? 'pending' : isSuccess ? 'success' : 'error';
        const resultLabel = isTimeout ? '结果未知' : isSuccess ? (record.type === 'print' ? '已提交' : '成功') : '失败';
        const dateLabel = record.createdAt > 0
          ? new Date(record.createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
          : '本次操作';
        const timeLabel = record.time.replace(/\s?(AM|PM)$/i, '');
        const compactTime = timeLabel.match(/^\d{1,2}:\d{2}/)?.[0] ?? timeLabel;

        return (
          <article
            key={record.id}
            className={`cmhub-log-row ${record.id === latestLogId ? 'is-latest' : ''} is-${visualStatus}`}
            role="listitem"
          >
            <div className="cmhub-log-row-time">
              <time dateTime={record.createdAt > 0 ? new Date(record.createdAt).toISOString() : undefined}>
                <span>{dateLabel}</span>
                <strong>{compactTime}</strong>
              </time>
            </div>
            <div className="cmhub-log-row-subject">
              <strong>{record.firstLeg || '未命名对象'}</strong>
              <span>{record.exchange ? `→ ${record.exchange}` : record.type === 'import' ? '导入数据记录' : record.type === 'system' ? '系统运行记录' : '未匹配单号'}</span>
            </div>
            <div className="cmhub-log-row-detail">
              <span>{record.message}</span>
            </div>
            <Tag
              className={`cmhub-log-result is-${visualStatus}`}
              size="small"
              theme={visualStatus === 'success' ? 'success' : visualStatus === 'pending' ? 'warning' : 'danger'}
              variant="light"
            >
              {resultLabel}
            </Tag>
          </article>
        );
      })}
    </div>
  );
}

export default memo(PrintLogTable);
