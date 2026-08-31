import { useEffect, useRef } from 'react';
import { Button, Tag } from '@arco-design/web-react';
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
    <section className="cmhub-intercept-alert" role="alertdialog" aria-modal="true" aria-labelledby="intercept-alert-title" aria-describedby="intercept-alert-description">
      <div className="cmhub-intercept-alert-panel">
        <Button
          ref={closeButtonRef}
          className="cmhub-intercept-alert-close"
          type="text"
          aria-label="确认已处理并返回扫码"
          icon={<X size={24} />}
          onClick={onConfirm}
        />
        <div className="cmhub-intercept-alert-icon" aria-hidden="true"><ShieldAlert size={54} strokeWidth={2.2} /></div>
        <Tag className="cmhub-intercept-alert-tag" color="red">拦截</Tag>
        <h1 id="intercept-alert-title">快件已阻断</h1>
        <p id="intercept-alert-description">命中全局拦截名单，请将该快件移入指定区域后再继续扫码。</p>
        <div className="cmhub-intercept-alert-waybill" aria-label={`拦截单号：${scannedValue}`}>{scannedValue}</div>
        <dl className="cmhub-intercept-alert-details">
          <div><dt>拦截原因</dt><dd>{rule.reason || '命中拦截名单'}</dd></div>
          <div><dt>添加来源</dt><dd>{rule.source === 'scan' ? '扫码录入' : '手动录入'}</dd></div>
        </dl>
        <Button className="cmhub-intercept-alert-confirm" type="primary" status="danger" size="large" onClick={onConfirm}>
          已移入拦截区，恢复扫码
        </Button>
      </div>
    </section>
  );
}
