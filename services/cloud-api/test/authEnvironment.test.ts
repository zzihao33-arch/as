import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';

function check(serviceEnvironment: string | undefined, keyEnvironment: 'test' | 'live', expected: number) {
  const env = { ...process.env, DOTENV_CONFIG_PATH: process.platform === 'win32' ? 'NUL' : '/dev/null', NODE_ENV: 'production', MYSQL_HOST: '127.0.0.1', MYSQL_DATABASE: 'unit_test', MYSQL_USER: 'unit_test', MYSQL_PASSWORD: 'unit_test', REDIS_URL: 'redis://127.0.0.1:6379', LABEL_STORAGE_BACKEND: 'filesystem', LABEL_STORAGE_ROOT: './test-labels', OUTBOUND_WEBHOOK_ENABLED: 'false' };
  if (serviceEnvironment) Object.assign(env, { API_KEY_ENVIRONMENT: serviceEnvironment });
  else delete (env as Record<string, string | undefined>).API_KEY_ENVIRONMENT;
  const script = `
    import assert from 'node:assert/strict';
    const { requireApiKey } = await import(${JSON.stringify(new URL('../src/auth.js', import.meta.url).href)});
    const { mysql, redis, closeConnections } = await import(${JSON.stringify(new URL('../src/db.js', import.meta.url).href)});
    const { issueApiKey } = await import(${JSON.stringify(new URL('../src/apiKeys.js', import.meta.url).href)});
    const issued = issueApiKey(${JSON.stringify(keyEnvironment)});
    let selectSql = ''; let selectArgs;
    mysql.execute = async (sql, args) => {
      if (sql.startsWith('SELECT')) {
        selectSql = sql; selectArgs = args;
        return [[{client_id:'client-test', api_key_id:'key-test', api_key_hash:issued.hash, scopes:['shipments:write','labels:write'], rate_limit_per_minute:600}], []];
      }
      return [{affectedRows:1}, []];
    };
    redis.incr = async () => 1;
    redis.expire = async () => 1;
    redis.quit = async () => 'OK';
    let result;
    const req = {header: () => issued.plaintext};
    await requireApiKey(req, {}, (error) => { result = error; });
    assert.equal(result?.status ?? 200, ${expected});
    if (${expected} === 200) {
      assert.equal(req.client.id, 'client-test');
      assert.match(selectSql, /k\\.environment = \\?/);
      assert.deepEqual(selectArgs, [issued.keyId, ${JSON.stringify(keyEnvironment.toUpperCase())}]);
    }
    await closeConnections();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 15000 });
  if (expected === 0) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /API_KEY_ENVIRONMENT must be one of/);
    return;
  }
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

it('accepts a test key on the test service while retaining production runtime settings', () => check('test', 'test', 200));
it('rejects live keys on an explicitly configured test service', () => check('test', 'live', 401));
it('rejects test keys on the default production service', () => check(undefined, 'test', 401));
it('accepts live keys on the default production service with matching stored environment', () => check(undefined, 'live', 200));
it('rejects an invalid service key environment at startup', () => check('tesst', 'test', 0));
