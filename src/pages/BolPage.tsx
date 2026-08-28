import { Card } from '@arco-design/web-react';
import BolManager from '../features/bol/BolManager';

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
        <BolManager />
      </Card>
    </section>
  );
}
