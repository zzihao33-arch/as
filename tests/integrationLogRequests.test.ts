import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogListLoader, createLogReadAcknowledgement, withLogRequestTimeout } from '../src/features/integrationLogs/requestLifecycle.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test('notifications during a slow list load coalesce without starving its result', async () => {
  const requests: { response: ReturnType<typeof deferred<string>>; signal: AbortSignal }[] = [];
  const shown: string[] = [];
  let idle = false;
  const loader = createLogListLoader({
    load(signal) { const response = deferred<string>(); requests.push({ response, signal }); return response.promise; },
    onStart() { idle = false; }, onSuccess(value) { shown.push(value); },
    onError(error) { throw error; }, onIdle() { idle = true; },
  });
  loader.refresh();
  loader.refresh(); loader.refresh(); loader.refresh();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, false);
  requests[0].response.resolve('entry snapshot');
  await settle();
  assert.deepEqual(shown, ['entry snapshot']);
  assert.equal(requests.length, 2, 'all arrivals queue only one follow-up request');
  requests[1].response.resolve('latest snapshot');
  await settle();
  assert.deepEqual(shown, ['entry snapshot', 'latest snapshot']);
  assert.equal(idle, true);
  loader.dispose();
});

test('changing filters aborts the old list and suppresses stale results and queued refreshes', async () => {
  const response = deferred<string>();
  let signal!: AbortSignal;
  const shown: string[] = [];
  const loader = createLogListLoader({
    load(value) { signal = value; return response.promise; }, onStart() {},
    onSuccess(value) { shown.push(value); }, onError(error) { throw error; }, onIdle() {},
  });
  loader.refresh(); loader.refresh(); loader.dispose();
  assert.equal(signal.aborted, true);
  response.resolve('obsolete result');
  await settle();
  assert.deepEqual(shown, []);
});

test('entry acknowledgement failure survives list replacement and retries its original cursor', async () => {
  const firstSave = deferred<void>();
  const saved: string[] = [];
  const errors: (string | null)[] = [];
  const read = createLogReadAcknowledgement({
    save(cursor) { saved.push(cursor); return saved.length === 1 ? firstSave.promise : Promise.resolve(); },
    onError(cursor) { errors.push(cursor); },
  });
  read.entry('20');
  read.entry('25'); // A new list effect/notification response must not replace the entry cursor.
  firstSave.reject(new Error('server unavailable'));
  await settle();
  assert.deepEqual(saved, ['20']);
  assert.deepEqual(errors, ['20']);
  await read.acknowledge(errors[0]!);
  assert.deepEqual(saved, ['20', '20'], 'retry must leave arrivals 21–25 unread');
  assert.deepEqual(errors, ['20', null]);
  read.dispose();
});

test('a read failure after page disposal cannot update the new page or account', async () => {
  const response = deferred<void>();
  const errors: (string | null)[] = [];
  const read = createLogReadAcknowledgement({ save: () => response.promise, onError: cursor => errors.push(cursor) });
  read.entry('20'); read.dispose();
  response.reject(new Error('late failure'));
  await settle();
  assert.deepEqual(errors, []);
});

test('a late failed read cannot overwrite a newer successful manual acknowledgement', async () => {
  const firstSave = deferred<void>();
  const errors: (string | null)[] = [];
  const read = createLogReadAcknowledgement({
    save: cursor => cursor === '20' ? firstSave.promise : Promise.resolve(),
    onError: cursor => errors.push(cursor),
  });
  read.entry('20');
  await read.acknowledge('25');
  firstSave.reject(new Error('late failure'));
  await settle();
  assert.deepEqual(errors, [null]);
  read.dispose();
});

test('a hung log request is aborted and reports a timeout after ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal!: AbortSignal;
  const pending = withLogRequestTimeout(value => { signal = value; return new Promise<never>(() => {}); });
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  t.mock.timers.tick(9999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  await rejected;
});

test('external cancellation aborts immediately without misreporting a timeout', async () => {
  const controller = new AbortController();
  let signal!: AbortSignal;
  const pending = withLogRequestTimeout(value => { signal = value; return new Promise<never>(() => {}); }, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  assert.equal(signal.aborted, true);
  await rejected;
});

test('completed requests clear their deadline and cancellation listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let signal!: AbortSignal;
  assert.equal(await withLogRequestTimeout(async value => { signal = value; return 'done'; }, controller.signal), 'done');
  controller.abort();
  t.mock.timers.tick(10000);
  assert.equal(signal.aborted, false);
});
