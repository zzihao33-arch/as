import { Card, Spin, Tag } from '@arco-design/web-react';
import { lazy, Suspense } from 'react';

const InterceptListPage = lazy(() => import('../features/intercepts/InterceptListPage'));

function InterceptListFallback() {
  return (
    <section className="cmhub-page cmhub-intercept-page" aria-labelledby="intercept-loading-title">
      <div className="cmhub-page-heading">
        <div>
          <h1 id="intercept-loading-title">拦截名单</h1>
          <p>本机缓存实时匹配扫描单号；命中后将立即阻断打印任务。</p>
        </div>
        <Tag color="red" bordered={false}>本地硬拦截</Tag>
      </div>
      <Card className="cmhub-module-frame">
        <div className="cmhub-module-loading" role="status" aria-live="polite">
          <Spin /> 正在加载拦截名单…
        </div>
      </Card>
    </section>
  );
}

export default function InterceptPage() {
  return (
    <Suspense fallback={<InterceptListFallback />}>
      <InterceptListPage />
    </Suspense>
  );
}
