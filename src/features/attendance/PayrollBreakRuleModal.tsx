import { Alert, Input, Message, Modal, Table } from '@arco-design/web-react';
import { useEffect, useState } from 'react';
import { listAttendancePayrollBreakRules, saveAttendancePayrollBreakRule, type AttendancePayrollBreakRule } from '../session/warehouseApi';

export function PayrollBreakRuleModal({ target, onClose, onSaved }: {
  target: { employeeReference: string | null; name: string; effectiveFrom: string };
  onClose: () => void; onSaved: () => void;
}) {
  const [rules, setRules] = useState<AttendancePayrollBreakRule[]>([]);
  const [startTime, setStart] = useState('12:00');
  const [endTime, setEnd] = useState('13:00');
  const [effectiveFrom, setDate] = useState(target.effectiveFrom);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    listAttendancePayrollBreakRules().then(items => {
      if (!active) return;
      setRules(items);
      const applicable = items.filter(rule => rule.effectiveFrom <= target.effectiveFrom
        && (rule.employeeReference === target.employeeReference || rule.employeeReference === null))
        .sort((a, b) => Number(b.employeeReference !== null) - Number(a.employeeReference !== null)
          || b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
      if (applicable) { setStart(applicable.startTime); setEnd(applicable.endTime); }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '休息规则加载失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [target]);
  const duration = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const minutes = duration(endTime) - duration(startTime);
  const save = async () => {
    if (!effectiveFrom || !(minutes > 0)) { Message.error('请选择生效日期，休息结束时间须晚于开始时间。'); return; }
    setSaving(true);
    try {
      await saveAttendancePayrollBreakRule({ employeeReference: target.employeeReference, startTime, endTime, effectiveFrom });
      Message.success('休息规则已保存，薪酬将重新计算。');
      onSaved(); onClose();
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '保存失败'); }
    finally { setSaving(false); }
  };
  return <Modal className="cmhub-attendance-modal" title={`休息时间 · ${target.name}`} visible onCancel={onClose}
    onOk={() => void save()} confirmLoading={saving} okButtonProps={{ disabled: loading || Boolean(error) }} okText="保存并重新计算">
    <Alert type="info" content="员工个人规则优先于默认规则；只扣除与实际出勤重叠的时间。按 America/New_York 时区计算。" />
    {error && <Alert type="error" content={error} />}
    <div className="cmhub-attendance-form-grid">
      <label>休息开始<Input type="time" value={startTime} onChange={setStart} /></label>
      <label>休息结束<Input type="time" value={endTime} onChange={setEnd} /></label>
      <label>生效日期<Input type="date" value={effectiveFrom} onChange={setDate} /></label>
      <label>休息时长<Input readOnly value={minutes > 0 ? `${minutes} 分钟` : '请选择有效时段'} /></label>
    </div>
    <p>相同生效日期的保存会更新该规则；已固化的薪酬快照保留原结果。</p>
    <Table rowKey="id" loading={loading} pagination={false} size="small"
      data={rules.filter(rule => rule.employeeReference === target.employeeReference)}
      columns={[{ title: '生效日期', dataIndex: 'effectiveFrom' }, { title: '休息开始', dataIndex: 'startTime' }, { title: '休息结束', dataIndex: 'endTime' }]} />
  </Modal>;
}
