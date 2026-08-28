import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '../src/errors.js';
import { validateLabelPdf } from '../src/labelPdf.js';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF\n', 'ascii');
const sha256 = createHash('sha256').update(pdf).digest('hex');

describe('PDF label validation', () => {
  it('accepts a structurally recognizable PDF with a matching declared hash', () => {
    const result = validateLabelPdf(pdf, sha256.toUpperCase());
    assert.equal(result.sha256, sha256);
    assert.equal(result.byteSize, pdf.length);
    assert.strictEqual(result.content, pdf);
  });

  it('rejects a hash mismatch', () => {
    assert.throws(() => validateLabelPdf(pdf, '0'.repeat(64)), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, 'LABEL_HASH_MISMATCH');
      return true;
    });
  });

  it('rejects non-PDF content even when its hash matches', () => {
    const text = Buffer.from('this is not a PDF', 'utf8');
    const textHash = createHash('sha256').update(text).digest('hex');
    assert.throws(() => validateLabelPdf(text, textHash), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, 'INVALID_LABEL_PDF');
      return true;
    });
  });
});
