import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPickupDocumentChecker } from '../../../services/cloud-api/dist/pickupDocumentSandbox.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(process.env.PICKUP_DOCUMENT_FIXTURES || join(here, 'fixtures'));
const image = process.env.PICKUP_DOCUMENT_SANDBOX_IMAGE?.trim() || '';
const cases = [];
const startedAt = new Date().toISOString();
const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'ascii');
if (process.env.CMHUB_ACCEPT_SYNTHETIC_ONLY !== 'true' || !image) {
  throw new Error('Set CMHUB_ACCEPT_SYNTHETIC_ONLY=true and an immutable PICKUP_DOCUMENT_SANDBOX_IMAGE digest.');
}

const manifest = JSON.parse(await readFile(join(fixtureDirectory, 'manifest.json'), 'utf8'));
if (manifest.schemaVersion !== 1 || manifest.synthetic !== true || !Array.isArray(manifest.cases)) throw new Error('Synthetic fixture manifest is invalid.');
const root = await realpath(fixtureDirectory);
const checker = createPickupDocumentChecker({ image, timeoutMs: 30000 });
const signal = new AbortController().signal;

async function runCase(item, bytesOverride) {
  if (!['accept', 'reject'].includes(item.check) || typeof item.contentType !== 'string') throw new Error('Synthetic fixture case is invalid.');
  let bytes = bytesOverride;
  if (!bytes) {
    const candidate = resolve(root, item.file);
    if (isAbsolute(relative(root, candidate)) || relative(root, candidate).startsWith('..')) throw new Error('Fixture path escaped its directory.');
    const path = await realpath(candidate);
    if (isAbsolute(relative(root, path)) || relative(root, path).startsWith('..')) throw new Error('Fixture symlink escaped its directory.');
    bytes = await readFile(path);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== item.sha256) throw new Error('Synthetic fixture integrity check failed.');
  const expected = item.check;
  const started = performance.now();
  let outcome;
  try {
    const verdict = await checker(bytes, item.contentType, signal);
    outcome = verdict.clean && verdict.validated && verdict.contentType === item.contentType ? 'accept' : 'reject';
  } catch (error) {
    outcome = error instanceof Error && error.message === 'DOCUMENT_CHECK_UNAVAILABLE' ? 'unavailable' : 'error';
  }
  const passed = outcome === expected;
  cases.push({ id: item.id, expected, outcome, passed, elapsedMs: Math.round(performance.now() - started) });
}

for (const item of manifest.cases) await runCase(item);
await runCase({ id: 'av-eicar-synthetic', file: '', sha256: createHash('sha256').update(eicar).digest('hex'),
  contentType: 'application/pdf', check: 'reject' }, eicar);
const unsupportedXls = Buffer.from('synthetic legacy Excel test case', 'ascii');
const xlsDigest = createHash('sha256').update(unsupportedXls).digest('hex');
const xlsStarted = performance.now();
let xlsOutcome = 'error';
try {
  const verdict = await checker(unsupportedXls, 'application/vnd.ms-excel', signal);
  xlsOutcome = verdict.clean ? 'accept' : 'reject';
} catch (error) {
  xlsOutcome = error instanceof Error && error.message === 'DOCUMENT_CHECK_UNAVAILABLE' ? 'unavailable' : 'error';
}
cases.push({ id: 'legacy-xls-fails-closed', inputSha256: xlsDigest, expected: 'unavailable', outcome: xlsOutcome,
  passed: xlsOutcome === 'unavailable', elapsedMs: Math.round(performance.now() - xlsStarted) });

const imageDigest = image.match(/(?:^|@)sha256:([a-f0-9]{64})$/)?.[1];
if (!imageDigest) throw new Error('PICKUP_DOCUMENT_SANDBOX_IMAGE must end with an immutable sha256 digest.');
const report = { schemaVersion: 1, syntheticOnly: true, startedAt, completedAt: new Date().toISOString(),
  imageSha256: imageDigest, total: cases.length,
  passed: cases.filter(item => item.passed).length, failed: cases.filter(item => !item.passed).length, cases };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.failed !== 0) process.exitCode = 1;
