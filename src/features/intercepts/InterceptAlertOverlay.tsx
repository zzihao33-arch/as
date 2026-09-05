import { useEffect, useRef } from 'react';
import { Button } from 'tdesign-react';
import { ShieldAlert, X } from 'lucide-react';
import type { InterceptRule } from './useInterceptRules';

interface InterceptAlertOverlayProps {
  rule: InterceptRule;
  scannedValue: string;
  onConfirm: () => void;
}

export default function InterceptAlertOverlay({ rule, scannedValue, onConfirm }: InterceptAlertOverlayProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const blockEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', blockEscape, true);
    return () => window.removeEventListener('keydown', blockEscape, true);
  }, []);

  return (
    <section className="cmhub-intercept-alert" role="alertdialog" aria-modal="true" aria-labelledby="intercept-alert-title">
      <div className="cmhub-intercept-alert-panel">
        <Button
          ref={closeButtonRef}
          className="cmhub-intercept-alert-close"
          variant="text"
          aria-label="确认已处理并返回扫码"
          icon={<X size={24} />}
          onClick={onConfirm}
        />
        <header className="cmhub-intercept-alert-header">
          <span className="cmhub-intercept-alert-icon" aria-hidden="true"><ShieldAlert size={28} strokeWidth={2.35} /></span>
          <h1 id="intercept-alert-title">快件已阻断</h1>
        </header>
        <section className="cmhub-intercept-alert-waybill" aria-label={`拦截单号：${scannedValue}`}>
          <span>扫描单号</span>
          <strong>{scannedValue}</strong>
        </section>
        <dl className="cmhub-intercept-alert-details">
          <div><dt>拦截原因</dt><dd>{rule.reason || '命中拦截名单'}</dd></div>
          <div><dt>录入方式</dt><dd>{rule.source === 'scan' ? '扫码录入' : '手动录入'}</dd></div>
        </dl>
        <footer className="cmhub-intercept-alert-actions">
          <div>
            <strong>完成现场处置后恢复扫码</strong>
            <span>恢复前请确认快件已离开当前作业区</span>
          </div>
          <Button className="cmhub-intercept-alert-confirm" theme="danger" size="large" onClick={onConfirm}>
            已移入拦截区，恢复扫码
          </Button>
        </footer>
      </div>
    </section>
  );
}
