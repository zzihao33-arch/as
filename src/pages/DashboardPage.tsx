import { Button, Card, Empty, Grid, Tag } from '@arco-design/web-react';
import { ArrowRight, FilePlus2, PackageSearch, Printer } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const { Row, Col } = Grid;

export default function DashboardPage() {
  const navigate = useNavigate();
  const openRoute = (path: string) => {
    void navigate(path);
  };

  return (
    <section className="cmhub-page cmhub-dashboard-page" aria-labelledby="dashboard-title">
      <div className="cmhub-page-heading">
        <div>
          <h1 id="dashboard-title">运营工作台</h1>
          <p>从一个明确入口开始扫码、打单、生成 BOL 或处理考勤数据。</p>
        </div>
        <Tag color="green" bordered={false}>Arco 架构迁移 · 阶段 1</Tag>
      </div>

      <Row gutter={[16, 16]} className="cmhub-quick-actions">
        <Col xs={24} md={12} xl={8}>
          <Card className="cmhub-action-card cmhub-action-card-primary">
            <div className="cmhub-action-card-icon"><PackageSearch size={22} /></div>
            <h2>扫码打单</h2>
            <p>导入映射、连接本机打印机并处理连续扫描。</p>
            <Button type="primary" long icon={<ArrowRight size={16} />} onClick={() => openRoute('/operations/scan-print')}>进入工作台</Button>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={8}>
          <Card className="cmhub-action-card">
            <div className="cmhub-action-card-icon"><FilePlus2 size={22} /></div>
            <h2>生成 BOL</h2>
            <p>按渠道录入数量，实时预览并输出提货单。</p>
            <Button long icon={<ArrowRight size={16} />} onClick={() => openRoute('/bol/records')}>管理 BOL</Button>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={8}>
          <Card className="cmhub-action-card">
            <div className="cmhub-action-card-icon"><Printer size={22} /></div>
            <h2>设备与状态</h2>
            <p>检查当前电脑的 QZ Tray 连接和打印机选择。</p>
            <Button long icon={<ArrowRight size={16} />} onClick={() => openRoute('/settings/printer')}>查看设置</Button>
          </Card>
        </Col>
      </Row>

      <Card className="cmhub-dashboard-empty" title="本日运营概览">
        <Empty description="数据会在后续迁移中接入。当前可直接打开扫码打单工作台继续作业。" />
      </Card>
    </section>
  );
}
