import { memo } from 'react';
import { Button, Card, Space, Typography } from 'tdesign-react';
import { BookOpen, Download, ExternalLink, KeyRound, MonitorCheck, Printer, ShieldCheck } from 'lucide-react';

const { Title, Paragraph } = Typography;

const qzSteps = [
  { title: '下载并安装 QZ Tray', description: '在新电脑上安装官方 QZ Tray，并让右下角托盘图标保持运行', icon: Download },
  { title: '确认打印机驱动', description: '在 Windows 设置中确认已出现真实标签打印机，不选择 PDF 或 OneNote 等虚拟设备', icon: Printer },
  { title: '官方证书签名', description: '生产环境已接入 QZ 官方证书签名，可信请求不需要每张面单重复确认', icon: KeyRound },
  { title: '允许首次连接', description: '首次连接时仅对公司正式域名授权一次，之后保持 QZ Tray 在后台运行', icon: ShieldCheck },
  { title: '刷新并保存打印机', description: '回到系统设置刷新列表，选择实际标签打印机后保存即可开始直打', icon: MonitorCheck },
];

const QzSetupGuide = memo(function QzSetupGuide() {
  return (
    <Card className="cmhub-qz-guide-content" bordered={false} hoverShadow>
      <header className="cmhub-qz-guide-header">
        <div>
          <Title level="h5">新电脑直打配置</Title>
          <Paragraph className="cmhub-qz-guide-description">
            依次完成以下五步配置完成后，系统将通过 QZ Tray 直接调用本机标签打印机
          </Paragraph>
        </div>
        <Space className="cmhub-qz-guide-actions" breakLine>
          <Button theme="primary" icon={<Download size={16} />} href="https://qz.io/download/?os=windows" target="_blank">
            下载 QZ Tray <ExternalLink size={14} />
          </Button>
          <Button icon={<BookOpen size={16} />} href="https://qz.io/docs/signing-examples" target="_blank">
            官方教程 <ExternalLink size={14} />
          </Button>
        </Space>
      </header>

      <ol className="cmhub-qz-guide-steps" aria-label="QZ Tray 配置步骤">
        {qzSteps.map((step, index) => {
          const Icon = step.icon;
          return (
            <li key={step.title}>
              <span className="cmhub-qz-guide-step-index" aria-hidden="true">{index + 1}</span>
              <span className="cmhub-qz-guide-step-icon" aria-hidden="true"><Icon size={17} /></span>
              <div className="cmhub-qz-guide-step-copy">
                <strong>{step.title}</strong>
                <p>{step.description}</p>
              </div>
            </li>
          );
        })}
      </ol>
      <footer className="cmhub-qz-guide-footer">完成后回到“系统设置”刷新打印机列表，选择实际标签打印机并保存</footer>
    </Card>
  );
});

export default QzSetupGuide;
