export type PrintLogType = 'import' | 'print' | 'system';
export type PrintOutcome = 'SUCCESS' | 'DUPLICATE_OVERRIDE' | 'FAILED' | 'TIMEOUT';
export type ScanFeedbackState = 'idle' | 'processing' | 'success' | 'error';

export interface PrintLog {
  id: string;
  createdAt: number;
  time: string;
  firstLeg: string;
  exchange: string;
  status: 'success' | 'error';
  message: string;
  type: PrintLogType;
  outcome?: PrintOutcome;
}

export interface PrintLogInput {
  firstLeg: string;
  exchange: string;
  message: string;
  status: PrintLog['status'];
  type: PrintLogType;
  outcome?: PrintOutcome;
}

export const PRINT_LOG_TABS = [
  { key: 'print', title: '打印记录' },
  { key: 'import', title: '导入记录' },
  { key: 'system', title: '系统状态' }
] as const;

export type PrintLogTab = (typeof PRINT_LOG_TABS)[number]['key'];

export const SCAN_FEEDBACK_COPY: Record<ScanFeedbackState, string> = {
  idle: '已连接扫码枪',
  processing: '正在匹配并提交打印…',
  success: '匹配成功，打印任务已提交',
  error: '未匹配或打印失败，请核对单号'
};
