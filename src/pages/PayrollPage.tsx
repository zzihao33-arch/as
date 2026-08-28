import { Card, Result } from '@arco-design/web-react';
import { FileSpreadsheet } from 'lucide-react';
import PayrollManager from '../features/payroll/PayrollManager';

export default function PayrollPage() {
  return (
    <section className="cmhub-page cmhub-payroll-page" aria-labelledby="payroll-page-title">
      <div className="cmhub-page-heading">
        <div>
          <h1 id="payroll-page-title">考勤与薪酬</h1>
          <p>上传月度考勤表，核对工时、加班、油补和应发薪酬后导出汇总。</p>
        </div>
      </div>
      <Card className="cmhub-payroll-launcher">
        <Result
          icon={<FileSpreadsheet size={42} aria-hidden="true" />}
          title="打开考勤与薪酬计算"
          subTitle="系统会识别月度模板中的上下班时间和油补标记；所有计算都在本机浏览器中完成。"
          extra={<PayrollManager />}
        />
      </Card>
    </section>
  );
}
