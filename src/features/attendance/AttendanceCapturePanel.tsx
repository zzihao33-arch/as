import { Alert, Button, Card, Col, MessagePlugin as Message, Row, Space, Tag } from 'tdesign-react';
import { Camera, Clock3, LocateFixed, MapPin, RefreshCw, ShieldCheck, Wifi } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWarehouseSession } from '../session/WarehouseSessionProvider';
import {
  getAttendancePunchContext,
  submitAttendancePunch,
  type AttendancePunchContext,
} from '../session/warehouseApi';
import { ATTENDANCE_TIME_ZONE, attendanceElapsedMinutes, attendanceWorkDate, isOpenAttendanceWithin } from './attendanceTime';
import { cameraErrorMessage, isCameraBusyError, stopCameraStream } from './cameraStream';

type PositionSnapshot = { latitude: number; longitude: number; accuracy: number };
type GestureType = 'BLINK' | 'MOUTH_OPEN';

const mobileBrowser = () => {
  const coarsePointer = typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
  return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && coarsePointer);
};

const requestPosition = () => new Promise<PositionSnapshot>((resolve, reject) => {
  if (!navigator.geolocation) {
    reject(new Error('当前浏览器不支持定位'));
    return;
  }
  navigator.geolocation.getCurrentPosition(
    position => resolve({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
    }),
    () => reject(new Error('无法获取浏览器位置，请检查位置权限')),
    { enableHighAccuracy: true, timeout: 5_000, maximumAge: 15_000 },
  );
});

const canvasBlob = (canvas: HTMLCanvasElement, quality: number) => new Promise<Blob>((resolve, reject) => {
  canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法生成打卡照片')), 'image/jpeg', quality);
});

function sampleGestureFrame(video: HTMLVideoElement, gesture: GestureType) {
  const canvas = document.createElement('canvas');
  canvas.width = 80;
  canvas.height = 60;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法读取摄像头画面');
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
  if (!context) throw new Error('浏览器无法生成打卡照片');
  context.drawImage(video, 0, 0, width, height);
  for (const quality of [0.82, 0.72, 0.62, 0.52]) {
    const blob = await canvasBlob(canvas, quality);
    if (blob.size <= 1024 * 1024) return blob;
  }
  throw new Error('照片压缩后仍超过 1MB，请降低摄像头分辨率后重试');
}

const wait = (milliseconds: number) => new Promise(resolve => window.setTimeout(resolve, milliseconds));

export function AttendanceCapturePanel({ onChanged }: { onChanged(): void }) {
  const warehouseSession = useWarehouseSession();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraRequestIdRef = useRef(0);
  const loadedWorkDateRef = useRef(attendanceWorkDate());
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
      Message.error(cause instanceof Error ? cause.message : '考勤上下文加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadContext(); }, [loadContext]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const currentWorkDate = attendanceWorkDate(now);
  useEffect(() => {
    if (!currentWorkDate || currentWorkDate === loadedWorkDateRef.current) return;
    loadedWorkDateRef.current = currentWorkDate;
    void loadContext();
  }, [currentWorkDate, loadContext]);

  const stopActiveCamera = useCallback(() => {
    const video = videoRef.current;
    if (video) video.srcObject = null;
    stopCameraStream(streamRef.current);
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    const requestId = ++cameraRequestIdRef.current;
    stopActiveCamera();
    setCameraState('LOADING');
    setCameraError('');

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState('ERROR');
      setCameraError('当前浏览器不支持摄像头访问，请使用最新版 Chrome 或 Edge');
      return;
    }

    const requestStream = () => navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });

    try {
      let stream: MediaStream;
      try {
        stream = await requestStream();
      } catch (cause) {
        // A route change or hot reload may release the previous stream a few
        // frames late. One short retry covers that transition without masking
        // a real hardware conflict.
        if (!isCameraBusyError(cause)) throw cause;
        await wait(360);
        stream = await requestStream();
      }

      if (requestId !== cameraRequestIdRef.current) {
        stopCameraStream(stream);
        return;
      }

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stopActiveCamera();
        return;
      }
      video.srcObject = stream;
      await video.play();
      if (requestId === cameraRequestIdRef.current) setCameraState('READY');
    } catch (cause) {
      if (requestId !== cameraRequestIdRef.current) return;
      stopActiveCamera();
      setCameraState('ERROR');
      setCameraError(cameraErrorMessage(cause));
    }
  }, [stopActiveCamera]);

  useEffect(() => {
    void startCamera();
    return () => {
      cameraRequestIdRef.current += 1;
      stopActiveCamera();
    };
  }, [startCamera, stopActiveCamera]);

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
      const message = cause instanceof Error ? cause.message : '无法获取位置';
      setPositionError(message);
      if (isMobile) throw new Error(message);
      return null;
    }
  }, [isMobile]);

  useEffect(() => { void refreshPosition().catch(() => undefined); }, [refreshPosition]);

  const returnedResult = context?.todayResult ?? null;
  const returnedResultWorkDate = returnedResult?.clockInAt ? attendanceWorkDate(returnedResult.clockInAt) : returnedResult?.workDate;
  const openShiftIsEligible = returnedResult?.status === 'OPEN'
    && isOpenAttendanceWithin(returnedResult.clockInAt, now);
  const activeResult = returnedResult
    && (openShiftIsEligible || returnedResultWorkDate === currentWorkDate)
    ? returnedResult
    : null;
  const expiredOpenShift = returnedResult?.status === 'OPEN' && !openShiftIsEligible;
  const crossDayShift = Boolean(openShiftIsEligible && returnedResultWorkDate !== currentWorkDate);
  const punchType = !activeResult?.clockInAt ? 'IN' : !activeResult.clockOutAt ? 'OUT' : null;
  const gestureLabel = gesture === 'BLINK' ? '眨眼一次' : '张嘴一次';
  const clockText = now.toLocaleTimeString('zh-CN', { timeZone: ATTENDANCE_TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateText = now
    .toLocaleDateString('zh-CN', { timeZone: ATTENDANCE_TIME_ZONE, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
    .replace(/日(?=周)/, '日 · ');
  const calculatedWorkedMinutes = attendanceElapsedMinutes(activeResult?.clockInAt ?? null, activeResult?.clockOutAt ?? null, now);
  const workedMinutes = Math.max(activeResult?.grossMinutes ?? 0, calculatedWorkedMinutes);
  const workedHours = Math.floor(workedMinutes / 60);
  const workedRemainingMinutes = Math.max(0, 480 - workedMinutes);
  const workedMinuteRemainder = String(workedMinutes % 60).padStart(2, '0');
  const attendanceState = activeResult?.clockOutAt
    ? { label: '今日已完成', tone: 'complete' }
    : activeResult?.clockInAt
      ? { label: '工作进行中', tone: 'active' }
      : { label: '等待上班打卡', tone: 'pending' };

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
      Message.error(cause instanceof Error ? cause.message : '动作验证失败');
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
      if (isMobile && !currentPosition) throw new Error('手机打卡必须取得有效位置');
      if (!isMobile && !warehouseSession.workstation) throw new Error('当前电脑尚未注册为仓库工作站');
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
      if (!result.data.accepted) throw new Error(result.data.message || '本次打卡未被接受');
      Message.success(punchType === 'IN' ? '上班打卡成功' : '下班打卡成功');
      resetCapture();
      await loadContext();
      onChanged();
    } catch (cause) {
      Message.error(cause instanceof Error ? cause.message : '打卡提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Row className="cmhub-attendance-capture-grid" gutter={[20, 20]} aria-busy={loading}>
      <Col xs={12} lg={8}>
        <Space direction="vertical" size={20} className="cmhub-attendance-camera-column">
        <Card className="cmhub-attendance-camera-card" header="现场核验" headerBordered hoverShadow>
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
          {cameraState === 'ERROR' && <Alert
            theme="error"
            message={<span className="cmhub-attendance-camera-error">摄像头不可用：{cameraError}<Button variant="text" size="small" icon={<RefreshCw size={14} />} onClick={() => void startCamera()}>重新连接摄像头</Button></span>}
          />}
          {gestureState === 'FAILED' && <Alert theme="warning" message={`未检测到足够的动作变化，请正对摄像头重新${gestureLabel}`} />}
          {gestureState === 'PASSED' && <Alert theme="success" message="动作验证已通过，现场照片已生成" />}
          <div className="cmhub-attendance-camera-actions">
            <Button
              theme={gestureState === 'PASSED' ? 'default' : 'primary'}
              icon={gestureState === 'PASSED' ? <RefreshCw size={16} /> : <Camera size={16} />}
              disabled={cameraState !== 'READY' || gestureState === 'COUNTDOWN' || !punchType}
              loading={gestureState === 'COUNTDOWN'}
              onClick={gestureState === 'PASSED' ? resetCapture : () => void verifyGesture()}
            >{gestureState === 'PASSED' ? '重新拍摄' : `开始验证：${gestureLabel}`}</Button>
            <span>照片仅用于考勤审计，按规则保留 6 个月</span>
          </div>
        </Card>

      <Card className="cmhub-attendance-preflight-card" header="设备检测" headerBordered hoverShadow>
        <Space direction="vertical" size={4} className="cmhub-attendance-preflight-list">
        <div className="cmhub-attendance-preflight-row">
          <Camera size={18} />
          <span><strong>摄像头</strong><small>{cameraState === 'READY' ? '画面正常' : cameraState === 'ERROR' ? '需要处理' : '正在启动'}</small></span>
          <Tag theme={cameraState === 'READY' ? 'success' : cameraState === 'ERROR' ? 'danger' : 'primary'}>{cameraState === 'READY' ? '正常' : cameraState === 'ERROR' ? '异常' : '检测中'}</Tag>
        </div>
        <div className="cmhub-attendance-preflight-row">
          <LocateFixed size={18} />
          <span><strong>浏览器位置</strong><small>{position ? `精度约 ${Math.round(position.accuracy)} 米` : positionError || '正在获取'}</small></span>
          <Tag theme={position ? 'success' : isMobile ? 'danger' : 'warning'}>{position ? '已获取' : isMobile ? '必需' : '辅助'}</Tag>
        </div>
        <div className="cmhub-attendance-preflight-row">
          <Wifi size={18} />
          <span><strong>网络</strong><small>{navigator.onLine ? '可以连接考勤服务' : '当前设备离线'}</small></span>
          <Tag theme={navigator.onLine ? 'success' : 'danger'}>{navigator.onLine ? '在线' : '离线'}</Tag>
        </div>
        <div className="cmhub-attendance-preflight-row">
          <ShieldCheck size={18} />
          <span><strong>打卡方式</strong><small>{isMobile ? '移动端位置围栏' : warehouseSession.workstation?.displayName || '固定电脑工作站'}</small></span>
          <Tag theme="primary">{isMobile ? '移动端' : '工作站'}</Tag>
        </div>
        <Button variant="text" size="small" icon={<RefreshCw size={14} />} onClick={() => void refreshPosition().catch(() => undefined)}>重新获取位置</Button>
        </Space>
      </Card>
      </Space>
      </Col>

      <Col xs={12} lg={4}>
        <Card
          className="cmhub-attendance-status-card"
          header={crossDayShift ? '跨日班次' : '今日考勤'}
          headerBordered
          hoverShadow
          actions={crossDayShift ? <Tag className="cmhub-attendance-shift-chip" theme="warning">从 {returnedResultWorkDate} 延续</Tag> : <span className={`cmhub-attendance-day-status is-${attendanceState.tone}`}><i aria-hidden="true" />{attendanceState.label}</span>}
        >
          <Space direction="vertical" size={20} className="cmhub-attendance-status-stack">
            <div className="cmhub-attendance-time-card">
              <div className="cmhub-attendance-time-item cmhub-attendance-time-item--clock"><small>当前时间</small><div className="cmhub-attendance-clock-value">{clockText}</div></div>
              <div className="cmhub-attendance-time-item cmhub-attendance-time-item--date"><small>日期</small><strong>{dateText}</strong></div>
            </div>
            <div className="cmhub-attendance-day-timeline" role="group" aria-label={`上班 ${activeResult?.clockInAt ? '已完成' : '未完成'}，下班 ${activeResult?.clockOutAt ? '已完成' : '未完成'}`}>
              <div className={`cmhub-attendance-timeline-step ${activeResult?.clockInAt ? 'is-complete' : ''}`}><span className="cmhub-attendance-timeline-dot" aria-hidden="true" /><small>上班</small><strong>{activeResult?.clockInAt ? new Date(activeResult.clockInAt).toLocaleTimeString('zh-CN', { timeZone: ATTENDANCE_TIME_ZONE, hour12: false }) : '—'}</strong></div>
              <span className={`cmhub-attendance-timeline-rail ${activeResult?.clockOutAt ? 'is-complete' : ''}`} aria-hidden="true" />
              <div className={`cmhub-attendance-timeline-step ${activeResult?.clockOutAt ? 'is-complete' : ''}`}><span className="cmhub-attendance-timeline-dot" aria-hidden="true" /><small>下班</small><strong>{activeResult?.clockOutAt ? new Date(activeResult.clockOutAt).toLocaleTimeString('zh-CN', { timeZone: ATTENDANCE_TIME_ZONE, hour12: false }) : '—'}</strong></div>
            </div>
            <div className="cmhub-attendance-working-hours">
              <div className="cmhub-attendance-hours-heading"><span><small>已工作</small><em>今日累计工时</em></span><strong aria-label={`已工作 ${workedHours} 小时 ${workedMinuteRemainder} 分`}><span className="cmhub-attendance-duration-group"><b>{workedHours}</b><em>小时</em></span><span className="cmhub-attendance-duration-group"><b>{workedMinuteRemainder}</b><em>分</em></span></strong></div>
              <progress className="cmhub-attendance-work-progress" aria-label="今日工作时长进度" value={workedMinutes} max={480} />
              <small>目标 8 小时 · {workedRemainingMinutes > 0 ? `还差 ${Math.floor(workedRemainingMinutes / 60)} 小时 ${String(workedRemainingMinutes % 60).padStart(2, '0')} 分` : '已达成'}</small>
            </div>
            <div className="cmhub-attendance-rail-action">
              {expiredOpenShift && <Alert className="cmhub-attendance-expired-shift" theme="warning" message="上一班次已超过 18 小时，不能直接补下班卡；请在“异常申诉”中提交修正当前工作日可正常开始新班次" />}
              {punchType ? <Button theme="primary" block size="large" icon={punchType === 'IN' ? <MapPin size={20} /> : <Clock3 size={20} />} disabled={!photo || gestureState !== 'PASSED' || cameraState !== 'READY' || (!navigator.onLine) || (isMobile && !position)} loading={submitting} onClick={() => void submit()}>{punchType === 'IN' ? '上班打卡' : '下班打卡'}</Button> : <Alert theme="success" message="今日上下班打卡已完成" />}
            </div>
          </Space>
        </Card>
      </Col>
    </Row>
  );
}
