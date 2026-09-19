import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitsDocumentQuota, normalizeDocumentRegistration, validateDocumentContent, DOCUMENT_POLICY } from '../src/pickupDocumentPolicy.js';
import { createHash, randomUUID } from 'node:crypto';
import { documentPdf } from './documentFixtures.js';

test('document quota uses final active set, inclusive boundaries', () => {
  const limit = { count: 20, bytes: 209715200 };
  assert.equal(fitsDocumentQuota(20, 209715200, limit), true);
  assert.equal(fitsDocumentQuota(21, 1, limit), false);
  assert.equal(fitsDocumentQuota(20, 209715201, limit), false);
  assert.equal(fitsDocumentQuota(-1, 1, limit), false);
});
test('registration accepts exactly 25MiB, refuses 1 byte more and header injection', () => {
  const input = { uploadId: randomUUID(), filename: '中文.pdf', byteSize: 26214400, sha256: 'a'.repeat(64), declaredContentType: 'application/pdf', policyVersion: DOCUMENT_POLICY.policyVersion };
  assert.equal(normalizeDocumentRegistration(input).byteSize, 26214400);
  assert.throws(() => normalizeDocumentRegistration({ ...input, byteSize: 26214401 }), /25 MiB/);
  assert.throws(() => normalizeDocumentRegistration({ ...input, filename: 'bad\r\nname.pdf' }));
});
test('content checking fails closed without isolated checker and verifies actual server hash', async () => {
  const bytes = documentPdf();
  const metadata = normalizeDocumentRegistration({ uploadId: randomUUID(), filename: 'a.pdf', byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), declaredContentType: 'application/pdf', policyVersion: DOCUMENT_POLICY.policyVersion });
  await assert.rejects(validateDocumentContent(bytes, metadata), { code: 'DOCUMENT_CHECK_UNAVAILABLE' });
  await assert.rejects(validateDocumentContent(Buffer.from('x'.repeat(bytes.length)), metadata), { code: 'DOCUMENT_HASH_MISMATCH' });
});
test('isolated checker must report full parse, clean verdict and matching detected type; synthetic verdict is not real parsing', async () => {
  const bytes = documentPdf();
  const metadata = normalizeDocumentRegistration({ uploadId: randomUUID(), filename: 'fixture.pdf', declaredContentType: 'application/pdf', byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), policyVersion: DOCUMENT_POLICY.policyVersion });
  for (const verdict of [
    { clean: false, validated: true, contentType: 'application/pdf' },
    { clean: true, validated: false, contentType: 'application/pdf' },
    { clean: true, validated: true, contentType: 'application/msword' },
  ]) {
    await assert.rejects(validateDocumentContent(bytes, metadata, async () => verdict), { code: 'DOCUMENT_CONTENT_INVALID' });
  }
  await assert.rejects(validateDocumentContent(bytes, metadata, async () => { throw new Error('isolated scanner down'); }), { code: 'DOCUMENT_CHECK_UNAVAILABLE' });
  assert.equal(await validateDocumentContent(bytes, metadata, async () => ({ clean: true, validated: true, contentType: 'application/pdf' })), 'application/pdf');
  await assert.rejects(validateDocumentContent(Buffer.from(bytes), metadata, async candidate => { candidate[0] = 0; return { clean: true, validated: true, contentType: 'application/pdf' }; }), { code: 'DOCUMENT_HASH_MISMATCH' });
});
