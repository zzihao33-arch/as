import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../api/qz-sign.ts';

class MockResponse {
  statusCode = 200;
  body = '';
  headers = new Map<string, string>();

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  send(body: string) {
    this.body = body;
  }
}

const request = (overrides: Record<string, unknown> = {}) => ({
  method: 'POST',
  headers: {
    origin: 'https://cmhubtool.com',
    host: 'cmhubtool.com'
  },
  body: { request: 'a'.repeat(64) },
  ...overrides
});

test('QZ signing rejects requests without a browser origin', () => {
  const response = new MockResponse();
  handler(request({ headers: { host: 'cmhubtool.com' } }), response);

  assert.equal(response.statusCode, 403);
});

test('QZ signing accepts only the SHA-256 digest shape sent by qz-tray', () => {
  const response = new MockResponse();
  handler(request({ body: { request: 'not-a-qz-digest' } }), response);

  assert.equal(response.statusCode, 400);
  assert.match(response.body, /64/);
});

test('a valid same-origin digest reaches key configuration instead of being rejected', () => {
  const previousPlainKey = process.env.QZ_PRIVATE_KEY;
  const previousBase64Key = process.env.QZ_PRIVATE_KEY_BASE64;
  delete process.env.QZ_PRIVATE_KEY;
  delete process.env.QZ_PRIVATE_KEY_BASE64;

  try {
    const response = new MockResponse();
    handler(request(), response);
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /QZ_PRIVATE_KEY/);
  } finally {
    if (previousPlainKey === undefined) delete process.env.QZ_PRIVATE_KEY;
    else process.env.QZ_PRIVATE_KEY = previousPlainKey;
    if (previousBase64Key === undefined) delete process.env.QZ_PRIVATE_KEY_BASE64;
    else process.env.QZ_PRIVATE_KEY_BASE64 = previousBase64Key;
  }
});
