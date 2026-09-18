import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAudioArbitrator } from '../src/features/audio/audioArbitration.ts';

test('notification sound yields while scan feedback owns the audio channel', () => {
  const audio = createAudioArbitrator();
  assert.equal(audio.reserve('scan', 1_000, 800), true);
  assert.equal(audio.reserve('notification', 1_100, 300), false);
  assert.equal(audio.reserve('notification', 1_801, 300), true);
});

test('scan feedback preempts a notification reservation', () => {
  const audio = createAudioArbitrator();
  assert.equal(audio.reserve('notification', 1_000, 300), true);
  assert.equal(audio.reserve('scan', 1_050, 800), true);
  assert.equal(audio.current(1_100), 'scan');
});

test('intercept alerts outrank all other sounds until their window expires', () => {
  const audio = createAudioArbitrator();
  assert.equal(audio.reserve('intercept', 2_000, 6_100), true);
  assert.equal(audio.reserve('scan', 2_100, 800), false);
  assert.equal(audio.reserve('notification', 8_099, 300), false);
  assert.equal(audio.reserve('scan', 8_100, 800), true);
});
