import { Card, Spin } from '@arco-design/web-react';
import { lazy, Suspense } from 'react';

const PrintWorkspace = lazy(() => import('../features/printing/PrintWorkspace'));

function PrintWorkspaceFallback() {
  return (
    <section className="cmhub-page cmhub-module-page" aria-labelledby="operations-loading-title">
      <div className="cmhub-page-heading">
        <div>
          <h1 id="operations-loading-title">扫码与本机打印</h1>
          <p>正在准备扫码、面单匹配与本机打印工作区。</p>
        </div>
      </div>
      <Card className="cmhub-module-frame">
        <div className="cmhub-module-loading" role="status" aria-live="polite">
          <Spin /> 正在加载扫码打单模块…
        </div>
      </Card>
    </section>
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
