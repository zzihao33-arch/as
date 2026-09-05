import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraErrorMessage, stopCameraStream } from '../src/features/attendance/cameraStream.ts';

test('maps a busy camera to an actionable message instead of a permission failure', () => {
  const error = Object.assign(new Error('Device in use'), { name: 'NotReadableError' });
  assert.match(cameraErrorMessage(error), /正在被其他页面或应用占用/);
  assert.match(cameraErrorMessage(error), /重新连接摄像头/);
});

test('stops every prior camera track before a new connection is requested', () => {
  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => { stopped += 1; } }, { stop: () => { stopped += 1; } }] } as unknown as MediaStream;
  stopCameraStream(stream);
  assert.equal(stopped, 2);
});
