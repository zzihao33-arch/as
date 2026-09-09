#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const MAX_LABELS = 50_000;
const MAX_BATCH_SIZE = 5_000;
const MAX_CONCURRENCY = 50;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const SYNTHETIC_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

function positiveInteger(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return parsed;
}

export function validateTargetUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--target must be an absolute test target URL.');
  }

  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const sharedTest = url.hostname === 'api-test.cmhubtool.com';
  const validProtocol = local ? ['http:', 'https:'].includes(url.protocol) : url.protocol === 'https:';
  if (!validProtocol || (!local && !sharedTest) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('--target must be a test target: localhost, 127.0.0.1, or exact https://api-test.cmhubtool.com, with no credentials, path, query, or fragment.');
  }
  return url;
}

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`Missing value for ${flag ?? 'argument'}.`);
    if (!['--target', '--labels', '--batch-size', '--concurrency', '--pdf'].includes(flag)) throw new Error(`Unknown argument: ${flag}.`);
    values[flag] = value;
  }
  if (!values['--target']) throw new Error('--target is required.');
  validateTargetUrl(values['--target']);
  return {
    target: values['--target'],
    labels: positiveInteger(values['--labels'] ?? '100', '--labels', MAX_LABELS),
    batchSize: positiveInteger(values['--batch-size'] ?? '100', '--batch-size', MAX_BATCH_SIZE),
    concurrency: positiveInteger(values['--concurrency'] ?? '5', '--concurrency', MAX_CONCURRENCY),
    pdf: values['--pdf'],
  };
}

function percentile95(samples) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function makeBatch(runId, batchIndex, count, pdfBase64) {
  const suffix = String(batchIndex).padStart(6, '0');
  const runDigest = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  return {
    batchId: `TYG-LOAD-${runId}-${suffix}`,
    airPickup: {
      billNo: `999-${runDigest}-${suffix}`,
      forecastCartons: Math.max(1, count),
      forecastPackages: Math.max(1, count),
      forecastWeight: Math.max(1, count),
      forecastWeightUnit: 'KG',
    },
    shipments: Array.from({ length: count }, (_, itemIndex) => ({
      firstLegTrackingNo: `TYGLOAD${runId}${suffix}F${String(itemIndex).padStart(5, '0')}`,
      courierTrackingNo: `TYGLOAD${runId}${suffix}C${String(itemIndex).padStart(5, '0')}`,
      labelPdfBase64: pdfBase64,
    })),
  };
}

async function postBatch(endpoint, apiKey, runId, batchIndex, body) {
  const started = performance.now();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'idempotency-key': `TYG-LOAD-${runId}-${String(batchIndex).padStart(6, '0')}`,
      },
      body: JSON.stringify(body),
    });
    let payload;
    try { payload = await response.json(); } catch { payload = undefined; }
    const latencyMs = performance.now() - started;
    const countsMatch = payload?.data?.shipmentCount === body.shipments.length
      && payload?.data?.labelCount === body.shipments.length;
    const persisted = response.ok && countsMatch;
    const errorCode = persisted
      ? undefined
      : (payload?.error?.code || (response.ok ? 'INVALID_SUCCESS_RESPONSE' : `HTTP_${response.status}`));
    return { persisted, labels: persisted ? body.shipments.length : 0, errorCode, latencyMs };
  } catch (error) {
    return { persisted: false, labels: 0, errorCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR', latencyMs: performance.now() - started };
  }
}

export async function runLoadProbe({ target, labels, batchSize, concurrency, apiKey, pdfBytes, runId = Date.now().toString(36) }) {
  const url = validateTargetUrl(target);
  if (!apiKey) throw new Error('TYG_TEST_API_KEY is required.');
  positiveInteger(labels, '--labels', MAX_LABELS);
  positiveInteger(batchSize, '--batch-size', MAX_BATCH_SIZE);
  positiveInteger(concurrency, '--concurrency', MAX_CONCURRENCY);
  if (!Buffer.isBuffer(pdfBytes) || pdfBytes.length === 0 || pdfBytes.length > MAX_PDF_BYTES || !pdfBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error('PDF fixture must be a non-empty PDF no larger than 20 MiB.');
  }
  const safeRunId = runId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  if (!safeRunId) throw new Error('runId must contain a letter or number.');

  const pdfBase64 = pdfBytes.toString('base64');
  const totalBatches = Math.ceil(labels / batchSize);
  const largestBatch = makeBatch(safeRunId, 0, Math.min(batchSize, labels), pdfBase64);
  const largestBodyBytes = Buffer.byteLength(JSON.stringify(largestBatch));
  if (largestBodyBytes > MAX_JSON_BYTES) {
    throw new Error(`Generated request is ${(largestBodyBytes / 1024 / 1024).toFixed(2)} MiB, over the 32 MiB limit. Lower --batch-size or use a smaller PDF fixture.`);
  }
  const endpoint = new URL('/api/v1/inbound-batches', url);
  const results = new Array(totalBatches);
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, totalBatches) }, async () => {
    while (next < totalBatches) {
      const index = next++;
      const offset = index * batchSize;
      const batch = makeBatch(safeRunId, index, Math.min(batchSize, labels - offset), pdfBase64);
      results[index] = await postBatch(endpoint, apiKey, safeRunId, index, batch);
    }
  }));
  const elapsedSeconds = (performance.now() - started) / 1000;
  const errors = {};
  for (const result of results) if (result.errorCode) errors[result.errorCode] = (errors[result.errorCode] ?? 0) + 1;
  const persistedLabels = results.reduce((sum, result) => sum + result.labels, 0);
  return {
    target: url.origin,
    requests: { total: results.length, persisted: results.filter((result) => result.persisted).length },
    labels: { attempted: labels, persisted: persistedLabels },
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    throughput: { persistedLabelsPerSecond: Number((persistedLabels / Math.max(elapsedSeconds, 0.001)).toFixed(2)) },
    latencyMs: { samples: results.length, p95: Number(percentile95(results.map((result) => result.latencyMs)).toFixed(2)) },
    errors,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.TYG_TEST_API_KEY;
  if (!apiKey) throw new Error('Set TYG_TEST_API_KEY in the process environment. The probe does not read .env files.');
  const pdfBytes = options.pdf ? await readFile(options.pdf) : SYNTHETIC_PDF;
  if (!options.pdf) console.error('WARNING: using a synthetic PDF. This checks transport and persistence flow only; a realistic benchmark requires a representative local PDF fixture.');
  const result = await runLoadProbe({ ...options, apiKey, pdfBytes });
  console.log(JSON.stringify(result, null, 2));
  if (result.requests.persisted !== result.requests.total) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`Load probe refused or failed: ${error.message}`);
    process.exitCode = 1;
  });
}
