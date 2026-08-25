import { memo, useMemo } from 'react';
import { Table, Tag, Typography } from '@arco-design/web-react';
import type { PrintLog } from './printingTypes';

interface PrintLogTableProps {
  logs: Array<PrintLog & { rowNumber: number }>;
  latestLogId: string | null;
}

function PrintLogTable({ logs, latestLogId }: PrintLogTableProps) {
  const columns = useMemo(() => [
    { title: '序号', dataIndex: 'rowNumber', width: 80 },
    { title: '时间', dataIndex: 'time', width: 130 },
    {
      title: '相关单号/对象',
      dataIndex: 'firstLeg',
      render: (_: unknown, record: PrintLog) => record.type === 'print' ? (
        <div>
          <Typography.Text>{record.firstLeg}</Typography.Text>
          <br />
          <Typography.Text type="secondary">快递单号: {record.exchange}</Typography.Text>
        </div>
      ) : record.firstLeg
    },
    { title: '状态/详情', dataIndex: 'message' },
    {
      title: '结果',
      dataIndex: 'status',
      width: 100,
      render: (status: PrintLog['status']) => (
        <Tag color={status === 'success' ? 'green' : 'red'}>
          {status === 'success' ? '成功' : '失败'}
        </Tag>
      )
    }
  ], []);

  return (
    <Table
      className="cmhub-log-table"
      rowKey="id"
      border={false}
      pagination={false}
      scroll={{ y: 400 }}
      data={logs}
      columns={columns}
      rowClassName={(record) => record.id === latestLogId ? 'cmhub-latest-log' : ''}
    />
  );
}

export default memo(PrintLogTable);
