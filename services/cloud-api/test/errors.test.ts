import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeApiError } from '../src/errors.js';

describe('normalizeApiError', () => {
  it('maps invalid JSON errors to a 400 response', () => {
    const error = Object.assign(new SyntaxError('Unexpected token'), {
      status: 400,
      type: 'entity.parse.failed',
    });

    const apiError = normalizeApiError(error);

    assert.equal(apiError.status, 400);
    assert.equal(apiError.code, 'INVALID_JSON');
  });

  it('maps request body limit errors to a 413 response', () => {
    const error = Object.assign(new Error('request entity too large'), {
      status: 413,
      type: 'entity.too.large',
    });

    const apiError = normalizeApiError(error);

    assert.equal(apiError.status, 413);
    assert.equal(apiError.code, 'PAYLOAD_TOO_LARGE');
  });
});
