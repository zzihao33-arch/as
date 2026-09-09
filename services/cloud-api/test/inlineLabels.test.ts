import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stageInlineLabels } from '../src/inlineLabels.js';
import type { LabelStorage } from '../src/labelStorage.js';
import { ApiError } from '../src/errors.js';

test('large batches keep at most four private uploads in flight and preserve input pairing', async () => {
  let active = 0;
  let maxActive = 0;
  const saved = new Map<string, Buffer>();
  const storage = { put: async (key: string, bytes: Buffer) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, bytes[0] % 3));
    saved.set(key, bytes);
    active--;
  } } as LabelStorage;
  const inputs = Array.from({ length: 17 }, (_, index) => ({
    labelPdf: { content: Buffer.from([index]), sha256: String(index).padStart(64, '0'), byteSize: 1 },
  }));
  const result = await stageInlineLabels('client', inputs, storage);
  assert.ok(maxActive <= 4);
  assert.equal(saved.size, 17);
  result.forEach((label, index) => assert.equal(saved.get(label!.storageKey)![0], index));
});

test('failed staging waits for started uploads and never publishes a partial result', async () => {
  let finished = 0;
  const storage = { put: async (_key: string, bytes: Buffer) => {
    if (bytes[0] === 0) throw new Error('failed private provider request');
    await new Promise(resolve => setTimeout(resolve, 5));
    finished++;
  } } as LabelStorage;
  const inputs = Array.from({ length: 8 }, (_, index) => ({
    labelPdf: { content: Buffer.from([index]), sha256: String(index).padStart(64, '0'), byteSize: 1 },
  }));
  await assert.rejects(stageInlineLabels('client', inputs, storage),
    (error: unknown) => error instanceof ApiError && error.code === 'LABEL_STORAGE_UNAVAILABLE');
  assert.equal(finished, 3);
});
