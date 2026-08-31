import { Alert, Button, Card, Message, Progress, Tag } from '@arco-design/web-react';
import { Camera, CheckCircle2, Clock3, LocateFixed, MapPin, RefreshCw, ShieldCheck, Wifi } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWarehouseSession } from '../session/WarehouseSessionProvider';
import {
  getAttendancePunchContext,
  submitAttendancePunch,
  type AttendancePunchContext,
} from '../session/warehouseApi';

type PositionSnapshot = { latitude: number; longitude: number; accuracy: number };
type GestureType = 'BLINK' | 'MOUTH_OPEN';
const ATTENDANCE_TIME_ZONE = 'America/New_York';

const mobileBrowser = () => /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && window.matchMedia('(pointer: coarse)').matches);

const requestPosition = () => new Promise<PositionSnapshot>((resolve, reject) => {
  if (!navigator.geolocation) {
    reject(new Error('当前浏览器不支持定位。'));
    return;
  }
  navigator.geolocation.getCurrentPosition(
    position => resolve({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
    }),
    () => reject(new Error('无法获取浏览器位置，请检查位置权限。')),
    { enableHighAccuracy: true, timeout: 5_000, maximumAge: 15_000 },
  );
});

const canvasBlob = (canvas: HTMLCanvasElement, quality: number) => new Promise<Blob>((resolve, reject) => {
  canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法生成打卡照片。')), 'image/jpeg', quality);
});

function sampleGestureFrame(video: HTMLVideoElement, gesture: GestureType) {
  const canvas = document.createElement('canvas');
  canvas.width = 80;
  canvas.height = 60;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法读取摄像头画面。');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const y = gesture === 'BLINK' ? 12 : 30;
  const height = gesture === 'BLINK' ? 20 : 22;
  return context.getImageData(14, y, 52, height).data;
}

function frameDifference(before: Uint8ClampedArray, after: Uint8ClampedArray) {
  let difference = 0;
  for (let index = 0; index < before.length; index += 4) {
    difference += Math.abs(before[index] - after[index]);
    difference += Math.abs(before[index + 1] - after[index + 1]);
    difference += Math.abs(before[index + 2] - after[index + 2]);
  }
  return difference / ((before.length / 4) * 3 * 255);
}

async function captureCompressedPhoto(video: HTMLVideoElement) {
  const sourceWidth = video.videoWidth || 1280;
  const sourceHeight = video.videoHeight || 960;
  const scale = Math.min(
    1280 / Math.max(sourceWidth, sourceHeight),
    Math.max(1, 640 / sourceWidth, 480 / sourceHeight),
  );
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法生成打卡照片。');
  context.drawImage(video, 0, 0, width, height);
  for (const quality of [0.82, 0.72, 0.62, 0.52]) {
    const blob = await canvasBlob(canvas, quality);
    if (blob.size <= 1024 * 1024) return blob;
  }
  throw new Error('照片压缩后仍超过 1MB，请降低摄像头分辨率后重试。');
}

const wait = (milliseconds: number) => new Promise(resolve => window.setTimeout(resolve, milliseconds));

export function AttendanceCapturePanel({ onChanged }: { onChanged(): void }) {
  const warehouseSession = useWarehouseSession();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [context, setContext] = useState<AttendancePunchContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [cameraState, setCameraState] = useState<'LOADING' | 'READY' | 'ERROR'>('LOADING');
  const [cameraError, setCameraError] = useState('');
  const [position, setPosition] = useState<PositionSnapshot | null>(null);
  const [positionError, setPositionError] = useState('');
  const [gesture, setGesture] = useState<GestureType>(() => Math.random() > 0.5 ? 'BLINK' : 'MOUTH_OPEN');
  const [gestureState, setGestureState] = useState<'IDLE' | 'COUNTDOWN' | 'PASSED' | 'FAILED'>('IDLE');
  const [gestureScore, setGestureScore] = useState(0);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoUrl, setPhotoUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const isMobile = useMemo(mobileBrowser, []);

  const loadContext = useCallback(async () => {
    setLoading(true);
    try {
      setContext(await getAttendancePunchContext());
    } catch (cause) {
      Message.error(cause instanceof Error ? cause.message : '考勤上下文加载失败。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadContext(); }, [loadContext]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState('ERROR');
      setCameraError('当前浏览器不支持摄像头访问，请使用最新版 Chrome 或 Edge。');
      return () => { active = false; };
    }
    void navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    }).then(async stream => {
      if (!active) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraState('READY');
    }).catch(cause => {
      setCameraState('ERROR');
      setCameraError(cause instanceof Error ? cause.message : '摄像头不可用。');
    });
    return () => {
      active = false;
      streamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!photo) {
      setPhotoUrl('');
      return undefined;
    }
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const refreshPosition = useCallback(async () => {
    setPositionError('');
    try {
      const next = await requestPosition();
      setPosition(next);
      return next;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '无法获取位置。';
      setPositionError(message);
      if (isMobile) throw new Error(message);
      return null;
    }
  }, [isMobile]);

  useEffect(() => { void refreshPosition().catch(() => undefined); }, [refreshPosition]);

  const punchType = !context?.todayResult?.clockInAt ? 'IN' : !context.todayResult.clockOutAt ? 'OUT' : null;
  const gestureLabel = gesture === 'BLINK' ? '眨眼一次' : '张嘴一次';
  const clockText = now.toLocaleTimeString('zh-CN', { timeZone: ATTENDANCE_TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateText = now.toLocaleDateString('zh-CN', { timeZone: ATTENDANCE_TIME_ZONE, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const workedMinutes = context?.todayResult?.clockInAt
    ? Math.max(0, Math.round(((context.todayResult.clockOutAt ? new Date(context.todayResult.clockOutAt) : now).getTime() - new Date(context.todayResult.clockInAt).getTime()) / 60_000))
    : 0;
  const workedHoursText = `${Math.floor(workedMinutes / 60)}小时${String(workedMinutes % 60).padStart(2, '0')}分`;

  const verifyGesture = async () => {
    const video = videoRef.current;
    if (!video || cameraState !== 'READY') return;
    setGestureState('COUNTDOWN');
    setPhoto(null);
    try {
      const before = sampleGestureFrame(video, gesture);
      await wait(1_600);
      const after = sampleGestureFrame(video, gesture);
      const score = frameDifference(before, after);
      setGestureScore(score);
      if (score < 0.005) {
        setGestureState('FAILED');
        return;
      }
      setPhoto(await captureCompressedPhoto(video));
      setGestureState('PASSED');
    } catch (cause) {
      setGestureState('FAILED');
      Message.error(cause instanceof Error ? cause.message : '动作验证失败。');
    }
  };

  const resetCapture = () => {
    setGesture(Math.random() > 0.5 ? 'BLINK' : 'MOUTH_OPEN');
    setGestureState('IDLE');
    setGestureScore(0);
    setPhoto(null);
  };

  const submit = async () => {
    if (!punchType || !photo) return;
    setSubmitting(true);
    try {
      const currentPosition = await refreshPosition();
      if (isMobile && !currentPosition) throw new Error('手机打卡必须取得有效位置。');
      if (!isMobile && !warehouseSession.workstation) throw new Error('当前电脑尚未注册为仓库工作站。');
      const result = await submitAttendancePunch({
        photo,
        punchType,
        channel: isMobile ? 'MOBILE' : 'WORKSTATION',
        workstationId: isMobile ? undefined : warehouseSession.workstation?.id,
        gestureType: gesture,
        gesturePassed: gestureState === 'PASSED',
        gestureScore,
        clientCapturedAt: new Date().toISOString(),
        ...currentPosition,
      });
      if (!result.data.accepted) throw new Error(result.data.message || '本次打卡未被接受。');
      Message.success(punchType === 'IN' ? '上班打卡成功。' : '下班打卡成功。');
      resetCapture();
      await loadContext();
      onChanged();
    } catch (cause) {
      Message.error(cause instanceof Error ? cause.message : '打卡提交失败。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="cmhub-attendance-capture-grid" aria-busy={loading}>
      <div className="cmhub-attendance-camera-column">
        <Card className="cmhub-attendance-camera-card">
          <div className="cmhub-attendance-camera-frame">
            <video ref={videoRef} muted playsInline aria-label="打卡摄像头实时画面" />
            {photoUrl && <img src={photoUrl} alt="待提交的现场打卡照片" />}
            <span className="cmhub-attendance-live-badge"><i /> 实时画面</span>
            <div className="cmhub-attendance-camera-guide" aria-hidden="true" />
            {gestureState !== 'PASSED' && (
              <div className="cmhub-attendance-camera-prompt">
                <strong>{gestureState === 'COUNTDOWN' ? `现在请${gestureLabel}` : '请将面部置于框内'}</strong>
                <span>{gestureState === 'COUNTDOWN' ? '保持面部在框内' : `准备后完成${gestureLabel}`}</span>
              </div>
            )}
          </div>
          {cameraState === 'ERROR' && <Alert type="error" content={`摄像头不可用：${cameraError}`} />}
          {gestureState === 'FAILED' && <Alert type="warning" content={`未检测到足够的动作变化，请正对摄像头重新${gestureLabel}。`} />}
          {gestureState === 'PASSED' && <Alert type="success" content="动作验证已通过，现场照片已生成。" />}
          <div className="cmhub-attendance-camera-actions">
            <Button
              type={gestureState === 'PASSED' ? 'secondary' : 'primary'}
              icon={gestureState === 'PASSED' ? <RefreshCw size={16} /> : <Camera size={16} />}
              disabled={cameraState !== 'READY' || gestureState === 'COUNTDOWN' || !punchType}
              loading={gestureState === 'COUNTDOWN'}
              onClick={gestureState === 'PASSED' ? resetCapture : () => void verifyGesture()}
            >{gestureState === 'PASSED' ? '重新拍摄' : `开始验证：${gestureLabel}`}</Button>
            <span>照片仅用于考勤审计，按规则保留 6 个月。</span>
          </div>
        </Card>

        <Card className="cmhub-attendance-preflight-card">
          <div className="cmhub-attendance-preflight-row">
            <Camera size={18} />
            <span><strong>摄像头</strong><small>{cameraState === 'READY' ? '画面正常' : cameraState === 'ERROR' ? '需要处理' : '正在启动'}</small></span>
            <Tag color={cameraState === 'READY' ? 'green' : cameraState === 'ERROR' ? 'red' : 'arcoblue'}>{cameraState === 'READY' ? '正常' : cameraState === 'ERROR' ? '异常' : '检测中'}</Tag>
          </div>
          <div className="cmhub-attendance-preflight-row">
            <LocateFixed size={18} />
            <span><strong>浏览器位置</strong><small>{position ? `精度约 ${Math.round(position.accuracy)} 米` : positionError || '正在获取'}</small></span>
            <Tag color={position ? 'green' : isMobile ? 'red' : 'orange'}>{position ? '已获取' : isMobile ? '必需' : '辅助'}</Tag>
          </div>
          <div className="cmhub-attendance-preflight-row">
            <Wifi size={18} />
            <span><strong>网络</strong><small>{navigator.onLine ? '可以连接考勤服务' : '当前设备离线'}</small></span>
            <Tag color={navigator.onLine ? 'green' : 'red'}>{navigator.onLine ? '在线' : '离线'}</Tag>
          </div>
          <div className="cmhub-attendance-preflight-row">
            <ShieldCheck size={18} />
            <span><strong>打卡方式</strong><small>{isMobile ? '移动端位置围栏' : warehouseSession.workstation?.displayName || '固定电脑工作站'}</small></span>
            <Tag color="arcoblue">{isMobile ? '移动端' : '工作站'}</Tag>
          </div>
          <Button type="text" size="small" icon={<RefreshCw size={14} />} onClick={() => void refreshPosition().catch(() => undefined)}>重新获取位置</Button>
        </Card>
      </div>

      <div className="cmhub-attendance-check-column">
        <Card className="cmhub-attendance-time-card">
          <div><small>当前时间</small><strong>{clockText}</strong></div><i />
          <div><small>日期</small><strong>{dateText}</strong></div>
        </Card>
        <Card title="今日进度" className="cmhub-attendance-today-card">
          <div className="cmhub-attendance-punch-state">
            <div><span>上班</span><strong>{context?.todayResult?.clockInAt ? new Date(context.todayResult.clockInAt).toLocaleTimeString('zh-CN', { timeZone: ATTENDANCE_TIME_ZONE, hour12: false }) : '—'}</strong></div>
            <div className="cmhub-attendance-state-line"><Progress percent={context?.todayResult?.clockOutAt ? 100 : context?.todayResult?.clockInAt ? 50 : 0} showText={false} /></div>
            <div><span>下班</span><strong>{context?.todayResult?.clockOutAt ? new Date(context.todayResult.clockOutAt).toLocaleTimeString('zh-CN', { timeZone: ATTENDANCE_TIME_ZONE, hour12: false }) : '—'}</strong></div>
          </div>
          <div className="cmhub-attendance-working-hours"><span><small>已工作</small><strong>{workedHoursText}</strong></span><Progress percent={Math.min(100, Math.round(workedMinutes / 480 * 100))} showText={false} /><small>目标 8 小时</small></div>
        </Card>
        <div className="cmhub-attendance-submit-card">
          {punchType ? (
            <Button
              type="primary"
              long
              size="large"
              icon={punchType === 'IN' ? <MapPin size={20} /> : <Clock3 size={20} />}
              disabled={!photo || gestureState !== 'PASSED' || cameraState !== 'READY' || (!navigator.onLine) || (isMobile && !position)}
              loading={submitting}
              onClick={() => void submit()}
            ><span className="cmhub-attendance-submit-copy"><strong>{punchType === 'IN' ? '上班打卡' : '下班打卡'}</strong><small>{punchType === 'IN' ? 'CLOCK IN' : 'CLOCK OUT'}</small></span></Button>
          ) : (
            <Alert type="success" content={<span><CheckCircle2 size={15} /> 今日上下班打卡已完成</span>} />
          )}
          <small className="cmhub-attendance-server-time">以服务器时间为准 · {context?.serverTime ? new Date(context.serverTime).toLocaleString('zh-CN', { timeZone: ATTENDANCE_TIME_ZONE, hour12: false }) : '—'}</small>
        </div>
      </div>
    </div>
  );
}
