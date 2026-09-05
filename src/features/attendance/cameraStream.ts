export function stopCameraStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach(track => track.stop());
}

export function cameraErrorMessage(cause: unknown) {
  const name = cause instanceof Error ? cause.name : '';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '摄像头访问被浏览器拒绝，请检查此网站的摄像头权限后重新连接';
  }
  if (name === 'NotReadableError' || /device in use/i.test(cause instanceof Error ? cause.message : '')) {
    return '摄像头正在被其他页面或应用占用关闭占用程序后，请点击“重新连接摄像头”';
  }
  if (name === 'NotFoundError') {
    return '未检测到可用摄像头，请检查设备连接后重新连接';
  }
  if (name === 'OverconstrainedError') {
    return '当前摄像头不支持所需画面设置，请点击“重新连接摄像头”使用兼容设置';
  }
  return '摄像头暂时不可用，请确认设备未被占用后重新连接';
}

export function isCameraBusyError(cause: unknown) {
  return (cause instanceof Error && cause.name === 'NotReadableError')
    || /device in use/i.test(cause instanceof Error ? cause.message : '');
}
