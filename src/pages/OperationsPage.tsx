import { Card, Spin } from '@arco-design/web-react';
import { lazy, Suspense } from 'react';

const loadPrintWorkspace = () => import('../features/printing/PrintWorkspace');
const PrintWorkspace = lazy(loadPrintWorkspace);

export function preloadPrintWorkspace() {
  return loadPrintWorkspace();
}

function PrintWorkspaceFallback() {
  return (
    <main className="cmhub-operating-workspace" aria-busy="true" aria-labelledby="operations-loading-title">
      <div className="cmhub-operating-stack">
        <Card className="cmhub-operating-card cmhub-operating-overview" bordered>
          <header className="cmhub-operating-header">
            <div className="cmhub-operating-title">
              <div>
                <h3 id="operations-loading-title">扫码与本机打印</h3>
                <p>连续扫描后自动匹配面单，并发送至当前电脑的打印机。</p>
              </div>
            </div>
            <div className="cmhub-operating-header-actions">
              <div className="cmhub-header-metrics" aria-label="当前数据概览">
                <div className="text-center"><div className="text-2xl font-bold text-text-primary">0</div><div className="text-xs text-text-secondary uppercase font-semibold">EXCEL 条目</div></div>
                <div className="text-center border-x px-6 border-white/10"><div className="text-2xl font-bold text-text-primary">0</div><div className="text-xs text-text-secondary uppercase font-semibold">PDF 文件</div></div>
                <div className="text-center"><div className="text-2xl font-bold text-text-primary">0</div><div className="text-xs text-text-secondary uppercase font-semibold">已打印</div></div>
              </div>
              <div className="cmhub-workspace-loading" role="status" aria-live="polite">
                <Spin size={16} /> 正在准备工作区…
              </div>
            </div>
          </header>
        </Card>

        <Card className="cmhub-operating-card cmhub-scanner-card" bordered>
          <div className="cmhub-scan-entry-summary">
            <div className="cmhub-scan-entry-copy">
              <h2>扫码并打印</h2>
              <p>扫描或输入单号后，系统会匹配面单并发送至已选打印机。</p>
            </div>
          </div>
          <div className="cmhub-scan-stage">
            <div className="cmhub-workspace-loading" role="status" aria-live="polite">
              <Spin size={16} /> 正在加载扫码输入区…
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}

/**
 * Transitional route boundary. The legacy operational workflow remains intact
 * while its feature slices are extracted behind the new app shell.
 */
export default function OperationsPage() {
  return (
    <Suspense fallback={<PrintWorkspaceFallback />}>
      <PrintWorkspace />
    </Suspense>
  );
}
