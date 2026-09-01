import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Readable } from 'node:stream';
import {
  createCosLabelStorage,
  createFilesystemLabelStorage,
  type CosLabelStorageClient,
} from '../src/labelStorage.js';

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

describe('private COS label storage', () => {
  it('uses an isolated prefix, preserves immutable content, streams downloads, and removes objects', async () => {
    const objects = new Map<string, { content: Buffer; sha256: string }>();
    let bucketChecks = 0;
    let uploads = 0;
    const missing = () => Object.assign(new Error('missing'), { statusCode: 404, code: 'NoSuchKey' });
    const client: CosLabelStorageClient = {
      async headBucket() { bucketChecks += 1; },
      async headObject({ Key }) {
        const object = objects.get(Key);
        if (!object) throw missing();
        return { headers: {
          'content-length': String(object.content.length),
          'x-cos-meta-sha256': object.sha256,
        } };
      },
      async putObject(input) {
        uploads += 1;
        objects.set(input.Key, { content: input.Body, sha256: input['x-cos-meta-sha256'] });
      },
      getObjectStream({ Key }) {
        const object = objects.get(Key);
        if (!object) throw missing();
        return Readable.from(object.content);
      },
      async deleteObject({ Key }) {
        if (!objects.delete(Key)) throw missing();
      },
    };
    const storage = createCosLabelStorage({
      bucket: 'private-test-1234567890',
      region: 'na-ashburn',
      secretId: 'test-id',
      secretKey: 'test-key',
      prefix: '/test/v1/',
    }, client);
    const key = 'labels/client-1/shipment-1/abc.pdf';
    const content = Buffer.from('%PDF-1.7\n%%EOF\n', 'ascii');

    await storage.healthCheck();
    await storage.put(key, content);
    await storage.put(key, content);

    assert.equal(bucketChecks, 1);
    assert.equal(uploads, 1);
    assert.ok(objects.has(`test/v1/${key}`));
    const object = await storage.open(key);
    assert.equal(object.byteSize, content.length);
    assert.deepEqual(await readStream(object.stream), content);

    objects.set(`test/v1/${key}`, { content: Buffer.from('tampered'), sha256: 'bad' });
    await assert.rejects(storage.put(key, content), /does not match its storage key/);
    await storage.remove!(key);
    await storage.remove!(key);
    assert.equal(objects.size, 0);
  });

  it('rejects unsafe object prefixes and keys before contacting COS', async () => {
    const client = {} as CosLabelStorageClient;
    assert.throws(() => createCosLabelStorage({
      bucket: 'private-test-1234567890', region: 'na-ashburn', secretId: 'id', secretKey: 'key', prefix: '../test',
    }, client), /Invalid private label storage key/);
    const storage = createCosLabelStorage({
      bucket: 'private-test-1234567890', region: 'na-ashburn', secretId: 'id', secretKey: 'key', prefix: 'test',
    }, client);
    await assert.rejects(storage.put('../outside.pdf', Buffer.from('unsafe')), /Invalid private label storage key/);
  });
});
