import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArgs, runLoadProbe, validateTargetUrl } from './loadTygApi.mjs';

test('direct CLI execution rejects the production hostname before making a request', () => {
  const script = fileURLToPath(new URL('./loadTygApi.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [relative(process.cwd(), script), '--target', 'https://api.cmhubtool.com', '--labels', '1'], {
    encoding: 'utf8',
    env: { ...process.env, TYG_TEST_API_KEY: 'must-not-be-used' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /test target/i);
});

test('target guard accepts only HTTP localhost and HTTPS exact test hostname', () => {
  assert.equal(validateTargetUrl('http://localhost:8787').origin, 'http://localhost:8787');
  assert.equal(validateTargetUrl('http://127.0.0.1:8787/').hostname, '127.0.0.1');
  assert.equal(validateTargetUrl('https://api-test.cmhubtool.com').hostname, 'api-test.cmhubtool.com');

  for (const target of [
    'https://api.cmhubtool.com',
    'https://cmhubtool.com',
    'https://evil.example',
    'https://api-test.cmhubtool.com.evil.example',
    'https://user@api-test.cmhubtool.com',
    'https://api-test.cmhubtool.com?key=value',
    'https://api-test.cmhubtool.com/#fragment',
    'http://api-test.cmhubtool.com',
  ]) {
    assert.throws(() => validateTargetUrl(target), /test target/i, target);
  }
});

test('argument parser enforces bounded workload and explicit target', () => {
  assert.deepEqual(parseArgs(['--target', 'http://localhost:8787', '--labels', '12', '--batch-size', '5', '--concurrency', '2']), {
    target: 'http://localhost:8787', labels: 12, batchSize: 5, concurrency: 2, pdf: undefined,
  });
  assert.throws(() => parseArgs(['--labels', '1']), /--target/);
  assert.throws(() => parseArgs(['--target', 'http://localhost', '--labels', '0']), /--labels/);
  assert.throws(() => parseArgs(['--target', 'http://localhost', '--labels', '50001']), /--labels/);
  assert.throws(() => parseArgs(['--target', 'http://localhost', '--concurrency', '51']), /--concurrency/);
  assert.throws(() => parseArgs(['--target', 'http://localhost', '--batch-size', '5001']), /--batch-size/);
});

test('probe counts persisted labels, measures failures by HTTP and API code, and does not follow redirects', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ headers: request.headers, body });
    if (requests.length === 1) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { shipmentCount: body.shipments.length, labelCount: body.shipments.length }, requestId: 'safe-id' }));
    } else if (requests.length === 2) {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down' } }));
    } else {
      response.writeHead(302, { location: 'https://api.cmhubtool.com/api/v1/inbound-batches' });
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    const result = await runLoadProbe({
      target: `http://127.0.0.1:${address.port}`,
      labels: 5,
      batchSize: 2,
      concurrency: 2,
      apiKey: 'secret-test-key',
      pdfBytes: Buffer.from('%PDF-1.4\n%%EOF\n'),
      runId: 'test-run',
    });

    assert.equal(result.requests.total, 3);
    assert.equal(result.requests.persisted, 1);
    assert.equal(result.labels.attempted, 5);
    assert.equal(result.labels.persisted, 2);
    assert.deepEqual(result.errors, { 'HTTP_302': 1, 'RATE_LIMITED': 1 });
    assert.equal(result.latencyMs.samples, 3);
    assert.equal(typeof result.latencyMs.p95, 'number');
    assert.equal(typeof result.throughput.persistedLabelsPerSecond, 'number');
    assert.equal(JSON.stringify(result).includes('secret-test-key'), false);
    assert.equal(JSON.stringify(result).includes('labelPdfBase64'), false);
    assert.equal(requests.every(({ headers }) => headers['x-api-key'] === 'secret-test-key'), true);
    assert.equal(new Set(requests.map(({ headers }) => headers['idempotency-key'])).size, 3);
    assert.deepEqual(Object.keys(requests[0].body.airPickup).sort(), ['billNo', 'forecastCartons', 'forecastPackages', 'forecastWeight', 'forecastWeightUnit'].sort());
    assert.deepEqual(Object.keys(requests[0].body.shipments[0]).sort(), ['courierTrackingNo', 'firstLegTrackingNo', 'labelPdfBase64'].sort());
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('metadata-only success does not count labels as durably persisted', async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { shipmentCount: 1 }, requestId: 'legacy-response' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runLoadProbe({
      target: `http://127.0.0.1:${server.address().port}`,
      labels: 1, batchSize: 1, concurrency: 1, apiKey: 'test-key',
      pdfBytes: Buffer.from('%PDF-1.4\n%%EOF\n'), runId: 'metadata-only',
    });
    assert.equal(result.requests.persisted, 0);
    assert.equal(result.labels.persisted, 0);
    assert.deepEqual(result.errors, { INVALID_SUCCESS_RESPONSE: 1 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('separate run IDs produce distinct valid bill numbers', async () => {
  const billNumbers = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    billNumbers.push(body.airPickup.billNo);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { shipmentCount: 1, labelCount: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const runId of ['first-run', 'second-run']) {
      await runLoadProbe({
        target: `http://127.0.0.1:${server.address().port}`,
        labels: 1, batchSize: 1, concurrency: 1, apiKey: 'test-key',
        pdfBytes: Buffer.from('%PDF-1.4\n%%EOF\n'), runId,
      });
    }
    assert.equal(new Set(billNumbers).size, 2);
    assert.equal(billNumbers.every((value) => /^[A-Za-z0-9-]{1,32}$/.test(value)), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('generated request over 32 MiB is rejected locally with batching guidance', async () => {
  await assert.rejects(runLoadProbe({
    target: 'http://127.0.0.1:1',
    labels: 2, batchSize: 2, concurrency: 1, apiKey: 'test-key',
    pdfBytes: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(17 * 1024 * 1024)]),
    runId: 'oversize',
  }), /32 MiB.*batch-size/i);
});
