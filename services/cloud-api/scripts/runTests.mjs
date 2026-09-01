import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const testCacheDirectory = join(packageDirectory, 'node_modules', '.cache');
mkdirSync(testCacheDirectory, { recursive: true });
const outputDirectory = mkdtempSync(join(testCacheDirectory, 'cmhub-cloud-api-tests-'));
const tscPath = join(packageDirectory, 'node_modules', 'typescript', 'bin', 'tsc');
const testConfigPath = join(packageDirectory, 'tsconfig.test.json');

try {
  const compile = spawnSync(process.execPath, [
    tscPath,
    '-p',
    testConfigPath,
    '--noEmit',
    'false',
    '--outDir',
    outputDirectory,
  ], { cwd: packageDirectory, stdio: 'inherit' });

  if (compile.status !== 0) {
    process.exitCode = compile.status ?? 1;
  } else {
    writeFileSync(join(outputDirectory, 'package.json'), '{"type":"module"}\n', 'utf8');
    const tests = spawnSync(process.execPath, [
      '--test',
      join(outputDirectory, 'test', 'apiKeys.test.js'),
      join(outputDirectory, 'test', 'labelAssets.test.js'),
      join(outputDirectory, 'test', 'labelPdf.test.js'),
      join(outputDirectory, 'test', 'labelStorage.test.js'),
      join(outputDirectory, 'test', 'shipmentInput.test.js'),
      join(outputDirectory, 'test', 'shipmentIngest.test.js'),
      join(outputDirectory, 'test', 'errors.test.js'),
      join(outputDirectory, 'test', 'warehouseSecurity.test.js'),
      join(outputDirectory, 'test', 'warehouseOperations.test.js'),
      join(outputDirectory, 'test', 'warehouseHttp.test.js'),
      join(outputDirectory, 'test', 'outboundWebhooks.test.js'),
      join(outputDirectory, 'test', 'sharedWarehouseWork.test.js'),
      join(outputDirectory, 'test', 'airPickupOperations.test.js'),
      join(outputDirectory, 'test', 'inboundBatchIngest.test.js'),
      join(outputDirectory, 'test', 'attendanceCalculations.test.js'),
    ], { cwd: packageDirectory, stdio: 'inherit' });
    process.exitCode = tests.status ?? 1;
  }
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
