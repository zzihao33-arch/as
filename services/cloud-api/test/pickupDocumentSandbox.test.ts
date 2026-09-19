import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDocumentCheckerArgs, decodeDocumentCheckReply } from '../src/pickupDocumentSandbox.js';

const sha256 = 'a'.repeat(64);
const contentType = 'application/pdf';
const frame = (reply: Record<string, unknown>, extra = Buffer.alloc(0)) => Buffer.concat([Buffer.from(`${JSON.stringify(reply)}\n`), extra]);
const validReply = { protocol: 1, sourceSha256: sha256, contentType, clean: true, validated: true };

test('document checker accepts only an empty-payload clean verdict bound to the submitted bytes and type', () => {
  assert.deepEqual(decodeDocumentCheckReply(frame(validReply), sha256, contentType), { clean: true, validated: true, contentType });
  assert.throws(() => decodeDocumentCheckReply(frame({ ...validReply, sourceSha256: 'b'.repeat(64) }), sha256, contentType));
  assert.throws(() => decodeDocumentCheckReply(frame(validReply, Buffer.from('private-data')), sha256, contentType));
  assert.throws(() => decodeDocumentCheckReply(frame({ ...validReply, validated: false }), sha256, contentType));
});

test('document checker returns a rejection for parsed unsafe content and fails unavailable when signatures are stale', () => {
  assert.deepEqual(decodeDocumentCheckReply(frame({ ...validReply, clean: false, validated: false, errorCode: 'ACTIVE_CONTENT' }), sha256, contentType),
    { clean: false, validated: false, contentType });
  assert.throws(() => decodeDocumentCheckReply(frame({ ...validReply, clean: false, validated: false, errorCode: 'SCANNER_UNAVAILABLE' }), sha256, contentType),
    { message: 'DOCUMENT_CHECK_UNAVAILABLE' });
});

test('document checker fails closed on a malformed or oversized protocol header', () => {
  assert.throws(() => decodeDocumentCheckReply(Buffer.from('not-json\n'), sha256, contentType));
  assert.throws(() => decodeDocumentCheckReply(Buffer.concat([Buffer.alloc(8193, 97), Buffer.from('\n')]), sha256, contentType));
});

test('document checker container is pinned and receives no network, mounts or extra privileges', () => {
  const args = buildDocumentCheckerArgs(`registry.example/cmhub/checker@sha256:${sha256}`, `cmhub-document-123e4567-e89b-12d3-a456-426614174000`);
  for (const flag of ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user=65532:65532', '--memory=2g', '--memory-swap=2g', '--cpus=1', '--pids-limit=64', '--log-driver=none']) {
    assert.ok(args.includes(flag), `expected Docker option ${flag}`);
  }
  assert.equal(args.some(value => value.startsWith('--mount') || value.startsWith('-v')), false);
  assert.throws(() => buildDocumentCheckerArgs('registry.example/cmhub/checker:latest', 'cmhub-document-123e4567-e89b-12d3-a456-426614174000'));
});
