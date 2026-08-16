import { BookOpen, CheckCircle2, Download, ExternalLink, KeyRound, MonitorCheck, PlugZap, Printer, ShieldCheck } from 'lucide-react';

const qzSteps = [
  {
    title: '下载并安装 QZ Tray',
    description: '在新电脑上先安装官方 QZ Tray，安装完成后让右下角托盘图标保持运行。',
    icon: Download
  },
  {
    title: '确认打印机驱动',
    description: '把标签打印机接到电脑，确保 Windows 设置里能看到真实打印机，而不是 PDF/OneNote 这类虚拟设备。',
    icon: Printer
  },
  {
    title: '官方证书签名',
    description: '系统已接入 QZ 官方证书签名。管理员完成 Vercel 证书配置后，打印请求会以可信身份发送，减少每次确认弹窗。',
    icon: KeyRound
  },
  {
    title: '允许首次连接',
    description: '新电脑首次连接 QZ Tray 时，如出现连接授权，只对公司正式页面点击允许；正常打单不应每单重复弹窗。',
    icon: ShieldCheck
  },
  {
    title: '回到系统设置刷新',
    description: '打开 CM-HUB 的系统设置，刷新打印机列表，选择真实标签打印机并保存。',
    icon: MonitorCheck
  }
];

export default function QzSetupGuide() {
  return (
    <section className="bg-white/[0.045] backdrop-blur-xl rounded-4xl border border-brand-green/20 overflow-hidden">
      <div className="p-5 md:p-6 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5 border-b border-white/10">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-2xl bg-brand-green/15 flex items-center justify-center border border-brand-green/25">
            <PlugZap className="w-6 h-6 text-brand-green" />
          </div>
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-brand-green/10 px-3 py-1 text-xs font-bold text-brand-green">
              <CheckCircle2 className="w-3.5 h-3.5" />
              新电脑打印配置
            </div>
            <h2 className="mt-3 text-2xl font-bold text-text-primary">QZ Tray 下载与官方教程</h2>
            <p className="mt-2 text-sm leading-6 text-text-secondary/75 max-w-3xl">
              QZ Tray 是网页连接本机打印机的桥接程序。当前系统已采用 QZ 官方证书签名方案：新电脑只需安装 QZ Tray、确认打印机驱动、刷新列表即可测试直打。
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <a
            href="https://qz.io/download/?os=windows"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-green px-4 py-3 text-sm font-black text-dark-bg shadow-lg shadow-brand-green/20 hover:bg-brand-green/85 transition-all active:scale-[0.98]"
          >
            <Download className="w-4 h-4" />
            下载 QZ Tray
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <a
            href="https://qz.io/docs/signing-examples"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-bold text-text-primary hover:border-brand-green/40 hover:bg-brand-green/10 hover:text-brand-green transition-all active:scale-[0.98]"
          >
            <BookOpen className="w-4 h-4" />
            官方签名教程
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>

      <div className="grid md:grid-cols-5 gap-3 p-5 md:p-6">
        {qzSteps.map((step, index) => (
          <div key={step.title} className="rounded-2xl border border-white/10 bg-dark-bg/40 p-4">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-brand-green/10 flex items-center justify-center">
                <step.icon className="w-4 h-4 text-brand-green" />
              </div>
              <span className="text-xs font-black text-brand-green">STEP {index + 1}</span>
            </div>
            <h3 className="mt-4 font-bold text-text-primary">{step.title}</h3>
            <p className="mt-2 text-xs leading-5 text-text-secondary/65">{step.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
