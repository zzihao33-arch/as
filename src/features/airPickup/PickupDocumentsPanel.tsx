import { Alert, Button, Checkbox, Empty, Form, Input, Modal, Space, Spin, Tag } from '@arco-design/web-react';
import { Download, Eye, FileText, RefreshCw, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWarehouseSession } from '../session/WarehouseSessionProvider';
import { warehouseSessionFence } from '../session/sessionRecovery';
import { createDocumentUpload, DOCUMENT_JOURNAL_KEY, readDocumentJournal, writeDocumentJournal, type UploadState } from './pickupDocumentRecovery';
import { getDocumentPolicy, listPickupDocuments, putPickupDocument, queryPickupDocument, readPickupDocument,
  registerPickupDocument, reregisterPickupDocument, removePickupDocument, type DocumentAsset, type DocumentList, type DocumentPolicy, type Replacement } from './pickupDocumentsApi';
import './pickupDocuments.css';

const sizeLabel = (bytes: number) => `${(bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`;
const message = (error: unknown) => error instanceof Error ? error.message : '暂时无法完成，请重试。';
export function useDocumentPolicy() {
  const [policy, setPolicy] = useState<DocumentPolicy | null>(null);
  const [error, setError] = useState('');
  const [revision, reload] = useState(0);
  useEffect(() => {
    let current = true;
    void getDocumentPolicy().then(value => { if (current) { setPolicy(value); setError(''); } })
      .catch(cause => { if (current) setError(message(cause)); });
    return () => { current = false; };
  }, [revision]);
  return { policy, error, retry: () => reload(v => v + 1) };
}

export function DocumentFileSelection({ policy, files, onChange, disabled = false }: {
  policy: DocumentPolicy; files: File[]; onChange(files: File[]): void; disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  function choose(selected: File[]) {
    const invalid = selected.find(file => !policy.allowedExtensions.map(ext => ext.replace(/^\./, '').toLowerCase()).includes(file.name.split('.').pop()!.toLowerCase())
      || file.size <= 0 || file.size > policy.maxFileBytes);
    if (invalid) { setError(`${invalid.name}：请选择支持格式且不超过 ${sizeLabel(policy.maxFileBytes)} 的非空文件。`); return; }
    setError(''); onChange([...files, ...selected]);
  }
  return <section className="cmhub-pickup-file-selection" aria-label="选择提货凭证">
    <input ref={input} hidden type="file" multiple accept={policy.allowedExtensions.map(ext => '.' + ext.replace(/^\./, '')).join(',')}
      onChange={event => { choose(Array.from(event.target.files ?? [])); event.target.value = ''; }} disabled={disabled} />
    <Button icon={<Upload size={16} />} disabled={disabled} onClick={() => input.current?.click()}>选择提货凭证</Button>
    <p className="cmhub-document-help">支持 PDF、Excel、Word、图片；每份最多 {sizeLabel(policy.maxFileBytes)}。文件可后补，选择后尚未保存。</p>
    {error && <Alert className="cmhub-document-notice" type="error" content={error} />}
    {files.length > 0 && <ul className="cmhub-document-list">{files.map((file, index) => <li key={index}>
      <FileText size={18} aria-hidden="true" /><div><strong>{file.name}</strong><small>{sizeLabel(file.size)} · 待上传</small></div>
      <Button size="small" disabled={disabled} onClick={() => onChange(files.filter((_, i) => i !== index))}>移除</Button>
    </li>)}</ul>}
  </section>;
}

export function PickupDocumentsPanel({ orderId, initialFiles = [], onFilesAccepted, active = true }: {
  orderId: string; initialFiles?: File[]; onFilesAccepted?(): void; active?: boolean;
}) {
  const session = useWarehouseSession();
  const { policy, error: policyError, retry: retryPolicy } = useDocumentPolicy();
  const [list, setList] = useState<DocumentList | null>(null);
  const [history, setHistory] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [states, setStates] = useState<UploadState[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<{ url: string; filename: string; image: boolean } | null>(null);
  const [reading, setReading] = useState('');
  const [maintenance, setMaintenance] = useState<{ asset: DocumentAsset; mode: 'remove' | 'replace'; operationId: string } | null>(null);
  const [maintenanceFile, setMaintenanceFile] = useState<File | null>(null);
  const [maintenanceError, setMaintenanceError] = useState('');
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [registrationPrompt, setRegistrationPrompt] = useState<{ id: string; file?: File } | null>(null);
  const [registrationPassword, setRegistrationPassword] = useState('');
  const [maintenanceForm] = Form.useForm();
  const reselect = useRef<HTMLInputElement>(null);
  const reselectId = useRef('');
  const reselectRegistration = useRef(false);
  const controllers = useRef(new Map<string, ReturnType<typeof createDocumentUpload>>());
  const epoch = useRef(warehouseSessionFence.current());
  const live = useRef(true);
  const visible = useRef(active); visible.current = active;
  const sequence = useRef(0);
  const previewSequence = useRef(0);
  const latest = useRef({ policy, session, history }); latest.current = { policy, session, history };
  const accepted = useRef(false);
  const queueBusy = useRef(false);
  const current = useCallback(() => live.current && visible.current && warehouseSessionFence.isCurrent(epoch.current), []);
  const refresh = useCallback(async (append = false, cursor?: string) => {
    const seq = ++sequence.current;
    setLoading(true);
    try {
      const value = await listPickupDocuments(orderId, latest.current.history, cursor);
      if (!current() || seq !== sequence.current) return;
      setList(old => append && old && old.documentsRevision === value.documentsRevision
        ? { ...value, items: [...old.items, ...value.items] } : value); setError('');
    } catch (cause) { if (current() && seq === sequence.current) setError(message(cause)); }
    finally { if (current() && seq === sequence.current) setLoading(false); }
  }, [orderId, current]);
  function saveJournal() {
    try {
      const other = readDocumentJournal(sessionStorage.getItem(DOCUMENT_JOURNAL_KEY), latest.current.session.operationOwner)
        .filter(item => item.orderId !== orderId);
      const local = Array.from(controllers.current.values(), controller => controller.state());
      sessionStorage.setItem(DOCUMENT_JOURNAL_KEY, writeDocumentJournal([...other, ...local] as UploadState[], latest.current.session.operationOwner));
    } catch { /* Keep in-memory recovery when browser storage is unavailable. */ }
  }
  function addController(initial: { uploadId: string; orderId: string; filename: string; phase?: 'unknown'; registration?: Record<string, unknown> }, replacement?: Replacement) {
    const controller = createDocumentUpload(initial, {
      current,
      changed: state => {
        setStates(Array.from(controllers.current.values(), item => item.state())); saveJournal();
        if (state.phase === 'saved' || state.phase === 'inactive') void refresh();
      },
      register: async file => {
        try { return await registerPickupDocument(orderId, initial.uploadId, file as File, latest.current.policy!.policyVersion, replacement, controller.prepared); }
        finally { if (replacement) replacement.password = ''; replacement = undefined; }
      },
      reregister: file => reregisterPickupDocument(orderId, initial.uploadId, file as File),
      replay: (file, metadata, password) => reregisterPickupDocument(orderId, initial.uploadId, file as File, metadata, password),
      put: (file, attempt, retry) => putPickupDocument(orderId, initial.uploadId, file, attempt, retry),
      query: () => queryPickupDocument(orderId, initial.uploadId),
    });
    controllers.current.set(initial.uploadId, controller); return controller;
  }
  useEffect(() => {
    live.current = true;
    try {
      const journal = readDocumentJournal(sessionStorage.getItem(DOCUMENT_JOURNAL_KEY), session.operationOwner);
      for (const item of journal.filter(item => item.orderId === orderId)) addController({ ...item, phase: 'unknown' });
      setStates(Array.from(controllers.current.values(), item => item.state()));
    } catch { /* No saved query handles. */ }
    return () => { live.current = false; sequence.current++; previewSequence.current++; controllers.current.forEach(item => item.releaseFile()); };
    // The parent keys this panel by order and input identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (policy?.enabled && policy.capabilities.view) void refresh(); }, [policy, history, refresh]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => {
    if (!active) { previewSequence.current++; setPreview(null); setMaintenance(null); maintenanceForm.resetFields(); setMaintenanceFile(null); setFiles([]); setRegistrationPrompt(null); setRegistrationPassword(''); }
  }, [active, maintenanceForm]);
  useEffect(() => {
    if (!accepted.current && policy?.enabled && initialFiles.length) {
      accepted.current = true; setFiles(initialFiles); onFilesAccepted?.();
    }
  }, [initialFiles, policy, onFilesAccepted]);
  useEffect(() => {
    const start = Date.now();
    const timer = window.setInterval(() => {
      if (!current() || document.visibilityState !== 'visible' || Date.now() - start > 120_000) return;
      controllers.current.forEach(controller => { if (controller.state().phase === 'unknown') void controller.check(); });
    }, 5000);
    return () => clearInterval(timer);
  }, [current]);
  async function uploadSelected() {
    if (queueBusy.current || !policy || !files.length) return;
    queueBusy.current = true;
    const selected = files; setFiles([]);
    const tasks = selected.map(file => ({ file, controller: addController({ uploadId: crypto.randomUUID(), orderId, filename: file.name }) }));
    setStates(Array.from(controllers.current.values(), item => item.state())); saveJournal();
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(2, Math.max(1, policy.clientConcurrency)) }, async () => {
      while (index < tasks.length && current()) { const task = tasks[index++]; await task.controller.start(task.file); }
    }));
    queueBusy.current = false;
  }
  async function read(asset: DocumentAsset, download: boolean) {
    const seq = ++previewSequence.current; setReading(asset.assetId); setError('');
    try {
      const blob = await readPickupDocument(asset, download);
      if (!current() || seq !== previewSequence.current) return;
      const url = URL.createObjectURL(blob);
      if (download) { const link = document.createElement('a'); link.href = url; link.download = asset.filename;
        document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
      else setPreview({ url, filename: asset.filename, image: blob.type.startsWith('image/') });
    } catch (cause) { if (current() && seq === previewSequence.current) setError(message(cause)); }
    finally { if (current() && seq === previewSequence.current) setReading(''); }
  }
  const openMaintenance = (asset: DocumentAsset, mode: 'remove' | 'replace') => {
    maintenanceForm.resetFields(); setMaintenanceFile(null); setMaintenanceError('');
    setMaintenance({ asset, mode, operationId: crypto.randomUUID() });
  };
  function replayRegistration(id: string, selected?: File) {
    const controller = controllers.current.get(id); if (!controller) return;
    if (controller.state().registration?.supersedesAssetId) { setRegistrationPassword(''); setRegistrationPrompt({ id, file: selected }); }
    else void controller.replayRegistration(selected);
  }
  async function maintain(values: { reason: string; password: string }) {
    if (!maintenance || maintenanceBusy || !policy) return;
    if (maintenance.mode === 'replace' && !maintenanceFile) { setMaintenanceError('请选择更正版文件。'); return; }
    setMaintenanceBusy(true); setMaintenanceError('');
    try {
      if (maintenance.mode === 'remove') {
        await removePickupDocument(orderId, maintenance.asset.assetId, { ...values, operationId: maintenance.operationId, expectedAssetVersion: maintenance.asset.assetVersion });
        for (const controller of controllers.current.values()) if (controller.state().result?.recordRef?.id === maintenance.asset.assetId) void controller.check();
      } else {
        const controller = addController({ uploadId: maintenance.operationId, orderId, filename: maintenanceFile!.name }, {
          supersedesAssetId: maintenance.asset.assetId, expectedAssetVersion: maintenance.asset.assetVersion, ...values,
        });
        await controller.start(maintenanceFile!);
      }
      if (current()) { setMaintenance(null); maintenanceForm.resetFields(); setMaintenanceFile(null); await refresh(); }
    } catch (cause) { if (current()) setMaintenanceError(`${message(cause)} 请核对列表；再次验证会沿用本次操作编号。`); }
    finally { if (current()) setMaintenanceBusy(false); }
  }
  if (!policy) return <section className="cmhub-pickup-documents">{policyError
    ? <Alert className="cmhub-document-notice" type="warning" content="提货凭证暂时不可用" action={<Button onClick={retryPolicy}>重试</Button>} /> : <Spin />}</section>;
  if (!policy.enabled) return <Alert className="cmhub-document-notice" content="提货凭证功能尚未启用。" />;
  if (!policy.capabilities.view) return <Alert className="cmhub-document-notice" content="当前没有查看提货凭证的权限。" />;
  return <section className="cmhub-pickup-documents">
    <header><div><h3>提货凭证</h3><p>按提单保存原件，供内部员工查阅和下载。</p></div>
      <Button icon={<RefreshCw size={16} />} loading={loading} onClick={() => void refresh()}>刷新</Button></header>
    <Alert className="cmhub-document-notice" type="info" content="提单已保存。文件上传或预览失败不会影响提单，也不会改变物流状态。" />
    {error && <Alert className="cmhub-document-notice" type="error" content={error} action={<Button onClick={() => void refresh()}>重试列表</Button>} />}
    <div className="cmhub-document-summary"><strong>{list ? `已保存 ${list.savedCount} 份 · ${sizeLabel(list.activeBytes)}` : '正在核对已保存文件'}</strong>
      <small>每单最多 {policy.maxActiveFiles} 份 / {sizeLabel(policy.maxActiveBytes)}</small></div>
    {list?.capabilities.manage && <Checkbox checked={history} onChange={value => { setHistory(value); setList(null); }}>显示历史版本</Checkbox>}
    {list?.items.length === 0 && <Empty description={history ? '暂无提货凭证及历史版本' : '暂无已保存的提货凭证'} />}
    <ul className="cmhub-document-list">{list?.items.map(asset => <li key={asset.assetId}>
      <FileText size={20} aria-hidden="true" /><div className="cmhub-document-description"><strong>{asset.filename}</strong>
        <small>{sizeLabel(asset.byteSize)} · {new Date(asset.uploadedAt).toLocaleString()}</small>
        <Space wrap><Tag color={asset.assetStatus === 'READY' ? 'green' : 'gray'}>{asset.assetStatus === 'READY' ? '原件已保存' : asset.assetStatus === 'REMOVED' ? '已移除' : '已被替换'}</Tag>
          {!['application/pdf', 'image/png', 'image/jpeg'].includes(asset.contentType) && <span>请下载原件查看</span>}</Space>
        <Space wrap className="cmhub-document-actions">
          {asset.capabilities.view && ['application/pdf', 'image/png', 'image/jpeg'].includes(asset.contentType) && <Button icon={<Eye size={14} />} loading={reading === asset.assetId} onClick={() => void read(asset, false)}>查看</Button>}
          {asset.capabilities.download && <Button icon={<Download size={14} />} loading={reading === asset.assetId} onClick={() => void read(asset, true)}>下载原件</Button>}
          {asset.capabilities.manage && asset.assetStatus === 'READY' && <>
            {asset.capabilities.add && <Button onClick={() => openMaintenance(asset, 'replace')}>替换</Button>}
            <Button status="danger" onClick={() => openMaintenance(asset, 'remove')}>移除</Button></>}
        </Space>
      </div>
    </li>)}</ul>
    {list?.nextCursor && <Button loading={loading} onClick={() => void refresh(true, list.nextCursor!)}>加载更多</Button>}
    {states.length > 0 && <section aria-label="逐文件上传结果"><h4>本次文件</h4><ul className="cmhub-document-list">{states.map(state => <li key={state.uploadId}>
      <FileText size={18} aria-hidden="true" /><div><strong>{state.filename}</strong><small role="status">{state.message || '等待上传'}</small>
        <Space wrap>
          {!['saved', 'inactive', 'selected', 'not_saved'].includes(state.phase) && <Button size="small" loading={state.busy} onClick={() => void controllers.current.get(state.uploadId)?.check()}>核对原文件</Button>}
          {state.phase === 'unknown' && !state.result && state.registration && <Button size="small" disabled={state.busy} onClick={() => {
            if (state.hasFile) replayRegistration(state.uploadId);
            else { reselectId.current = state.uploadId; reselectRegistration.current = true; reselect.current?.click(); }
          }}>继续原文件注册</Button>}
          {['saved', 'inactive', 'not_saved'].includes(state.phase) && !state.result?.retryable && <Button size="small" onClick={() => {
            controllers.current.delete(state.uploadId); setStates(Array.from(controllers.current.values(), item => item.state())); saveJournal();
          }}>关闭此项</Button>}
          {(state.phase === 'waiting' || (state.phase === 'not_saved' && state.result?.retryable)) && <Button size="small" disabled={state.busy} onClick={() => {
            if (state.hasFile) void controllers.current.get(state.uploadId)?.retry();
            else { reselectId.current = state.uploadId; reselectRegistration.current = false; reselect.current?.click(); }
          }}>{state.hasFile ? '重试此文件' : '重新选择原文件'}</Button>}
        </Space></div>
    </li>)}</ul><p className="cmhub-document-help">刷新后保留原注册信息，文件内容需重新选择；关闭窗口后未上传的文件也需重选。</p></section>}
    <input hidden type="file" ref={reselect} onChange={event => { const file = event.target.files?.[0];
      if (file) { if (reselectRegistration.current) replayRegistration(reselectId.current, file); else void controllers.current.get(reselectId.current)?.reselect(file); }
      event.target.value = ''; }} />
    {list?.capabilities.add && <><DocumentFileSelection policy={policy} files={files} onChange={setFiles} />
      {files.length > 0 && <Button type="primary" onClick={() => void uploadSelected()}>上传 {files.length} 份文件</Button>}</>}
    <Modal className="cmhub-document-preview-modal" title={preview?.filename ?? '文件预览'} visible={Boolean(preview)} footer={null}
      onCancel={() => { previewSequence.current++; setPreview(null); }} unmountOnExit>
      {preview && (preview.image ? <img className="cmhub-document-image" src={preview.url} alt={preview.filename} />
        : <iframe title={preview.filename} src={preview.url} className="cmhub-document-pdf" />)}
    </Modal>
    <Modal className="cmhub-document-maintenance" title={maintenance?.mode === 'replace' ? '替换提货凭证' : '移除提货凭证'} visible={Boolean(maintenance)}
      confirmLoading={maintenanceBusy} okText="验证并确认" onCancel={() => { if (!maintenanceBusy) { setMaintenance(null); maintenanceForm.resetFields(); setMaintenanceFile(null); } }} onOk={() => maintenanceForm.submit()}>
      <p className="cmhub-document-filename">{maintenance?.asset.filename}</p>
      <Alert className="cmhub-document-notice" type="warning" content={maintenance?.mode === 'replace' ? '更正版保存成功后才替换旧版，失败时旧版保留。' : '移除后保留原件及操作历史。'} />
      {maintenanceError && <Alert className="cmhub-document-notice" type="error" content={maintenanceError} />}
      <Form form={maintenanceForm} layout="vertical" onSubmit={values => void maintain(values as { reason: string; password: string })}>
        {maintenance?.mode === 'replace' && <input aria-label="选择更正版文件" type="file" onChange={event => setMaintenanceFile(event.target.files?.[0] ?? null)} />}
        <Form.Item label="原因" field="reason" rules={[{ required: true, message: '请填写原因' }]}><Input.TextArea maxLength={500} /></Form.Item>
        <Form.Item label="验证当前账号密码" field="password" rules={[{ required: true, message: '请输入密码' }]}><Input.Password autoComplete="current-password" /></Form.Item>
      </Form>
    </Modal>
    <Modal className="cmhub-document-maintenance" title="继续原文件替换" visible={Boolean(registrationPrompt)} okText="验证并继续"
      onCancel={() => { setRegistrationPrompt(null); setRegistrationPassword(''); }} onOk={() => {
        if (!registrationPrompt || !registrationPassword) return;
        void controllers.current.get(registrationPrompt.id)?.replayRegistration(registrationPrompt.file, registrationPassword);
        setRegistrationPrompt(null); setRegistrationPassword('');
      }}>
      <p>沿用原文件编号和替换内容。请重新验证当前账号密码。</p>
      <Input.Password aria-label="继续替换验证密码" value={registrationPassword} onChange={setRegistrationPassword} autoComplete="current-password" />
    </Modal>
  </section>;
}
