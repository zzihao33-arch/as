import { Card, Spin } from '@arco-design/web-react';
import { lazy, Suspense } from 'react';

const BolManager = lazy(() => import('../features/bol/BolManager'));

export default function BolPage() {
  return (
    <section className="cmhub-page cmhub-module-page" aria-labelledby="bol-page-title">
      <div className="cmhub-page-heading">
        <div>
          <h1 id="bol-page-title">BOL管理</h1>
          <p>创建、核对、保存并输出 Bill of Lading 提货单。</p>
        </div>
      </div>
      <Card className="cmhub-module-frame">
        <Suspense fallback={<div className="cmhub-module-loading"><Spin /> 正在加载 BOL 模块…</div>}>
          <BolManager />
        </Suspense>
      </Card>
    </section>
  );
}
