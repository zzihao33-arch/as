import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createFilesystemLabelStorage } from '../src/labelStorage.js';

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('private filesystem label storage', () => {
  it('stores immutable content and opens it through the storage interface', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cmhub-label-storage-'));
    try {
      const storage = createFilesystemLabelStorage(root);
      const key = 'labels/client-1/shipment-1/abc.pdf';
      const content = Buffer.from('%PDF-1.7\n%%EOF\n', 'ascii');

      await storage.healthCheck();
      await storage.put(key, content);
      await storage.put(key, content);
      await assert.rejects(
        storage.put(key, Buffer.from('%PDF-1.7\ndifferent\n%%EOF\n', 'ascii')),
        /does not match its storage key/,
      );
      const object = await storage.open(key);

      assert.equal(object.byteSize, content.length);
      assert.deepEqual(await readStream(object.stream), content);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects storage keys that try to escape the private root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cmhub-label-storage-'));
    try {
      const storage = createFilesystemLabelStorage(root);
      await assert.rejects(storage.put('../outside.pdf', Buffer.from('unsafe')), /Invalid private label storage key/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
