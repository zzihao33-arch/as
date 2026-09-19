import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAccess, sameIdentityScope, createSessionFence, createProtectedDraftStore, readOwnedDraft, guardSessionRequest, warehouseSessionFence, StaleSessionResponse, assertCurrentSession, sessionInputOwner } from '../src/features/session/sessionRecovery.ts';

test('an unrelated successful read cannot restart repeated permission recovery', () => {
  const fence = createSessionFence();
  let recoveries = 0;
  fence.subscribe(() => { recoveries++; fence.advance(false); });
  for (let i = 0; i < 5; i++) {
    fence.succeeded(fence.current(), '/clients');
    fence.report(403, 'PERMISSION_DENIED', fence.current(), '/orders');
  }
  assert.equal(recoveries, 1);
  fence.succeeded(fence.current(), '/orders');
  fence.report(403, 'PERMISSION_DENIED', fence.current(), '/orders');
  assert.equal(recoveries, 2);
});

test('a historical permission failure cannot suppress a later session expiry', () => {
  const fence = createSessionFence();
  const failures: string[] = [];
  fence.subscribe(failure => { failures.push(failure); fence.advance(false); });
  fence.report(403, 'PERMISSION_DENIED', fence.current(), '/orders');
  fence.report(401, 'SESSION_INVALID', fence.current(), '/orders');
  assert.deepEqual(failures, ['permission', 'session']);
});

test('identity change during file preparation prevents the subsequent write', async () => {
  const epoch = warehouseSessionFence.current();
  let resume!: () => void;
  let writes = 0;
  const operation = (async () => {
    await new Promise<void>(resolve => { resume = resolve; });
    assertCurrentSession(epoch);
    writes++;
  })();
  warehouseSessionFence.advance();
  resume();
  await assert.rejects(operation, StaleSessionResponse);
  assert.equal(writes, 0);
});

test('persistent input owner rejects changed permissions after a browser restart', () => {
  const session = { userId: 'a', warehouseId: 'w', permissions: ['edit', 'view'], passwordState: 'ACTIVE' };
  const owner = sessionInputOwner(session);
  assert.equal(owner, sessionInputOwner({ ...session, permissions: ['view', 'edit'] }));
  const draft = JSON.stringify({ owner, savedAt: 1000, values: { billNo: '123' } });
  assert.equal(readOwnedDraft(draft, sessionInputOwner({ ...session, permissions: ['view'] }), 1000), null);
});

test('rejects responses from an earlier login even when the account and workspace match', () => {
  assert.equal(sameIdentityScope({ userId: 'a', warehouseId: 'w', epoch: 1 }, { userId: 'a', warehouseId: 'w', epoch: 2 }), false);
  assert.equal(sameIdentityScope({ userId: 'a', warehouseId: 'w', epoch: 2 }, { userId: 'b', warehouseId: 'w', epoch: 2 }), false);
});

test('operation password errors do not start login recovery', () => {
  assert.equal(classifyAccess(401, 'REAUTHENTICATION_FAILED'), 'reauthentication');
  assert.equal(classifyAccess(401, 'SESSION_REQUIRED'), 'session');
  assert.equal(classifyAccess(401, 'SESSION_INVALID'), 'session');
  assert.equal(classifyAccess(401, 'INVALID_CREDENTIALS'), 'other');
  assert.equal(classifyAccess(403, 'PERMISSION_DENIED'), 'permission');
  assert.equal(classifyAccess(500, 'REQUEST_FAILED'), 'other');
});

test('only one access recovery is announced for concurrent requests in the same identity generation', () => {
  const fence = createSessionFence();
  let recoveries = 0;
  const stop = fence.subscribe(() => { recoveries++; });
  const epoch = fence.current();
  fence.report(401, 'SESSION_REQUIRED', epoch);
  fence.report(401, 'SESSION_INVALID', epoch);
  assert.equal(recoveries, 1);
  fence.advance();
  fence.report(401, 'SESSION_REQUIRED', epoch);
  assert.equal(recoveries, 1);
  fence.report(403, 'PERMISSION_DENIED', fence.current());
  assert.equal(recoveries, 2);
  stop();
});

test('late async activation cannot publish after a workspace switch', async () => {
  const fence = createSessionFence();
  const old = fence.current();
  let finish!: () => void;
  const registration = new Promise<void>(resolve => { finish = resolve; });
  let visibleSession = 'new';
  const activation = registration.then(() => { if (fence.isCurrent(old)) visibleSession = 'old'; });
  fence.advance();
  finish();
  await activation;
  assert.equal(visibleSession, 'new');
});

test('temporary inputs survive same-owner recovery and are discarded on account, workspace or permission changes', () => {
  const drafts = createProtectedDraftStore();
  drafts.activate('a/w/view,edit');
  drafts.set('editor', { billNo: '123', remarks: 'keep' });
  drafts.activate('a/w/view,edit');
  assert.deepEqual(drafts.get('editor'), { billNo: '123', remarks: 'keep' });
  drafts.activate('a/w/view');
  assert.equal(drafts.get('editor'), undefined);
  drafts.set('editor', { billNo: '456' });
  drafts.activate('b/w/view');
  assert.equal(drafts.get('editor'), undefined);
  drafts.set('editor', { billNo: '789' });
  drafts.clear();
  drafts.activate('b/w/view');
  assert.equal(drafts.get('editor'), undefined);
});

test('persistent drafts reject legacy, foreign, expired and future-dated input', () => {
  const now = 10_000;
  const owner = 'a/w';
  assert.equal(readOwnedDraft(JSON.stringify({ savedAt: now, values: { billNo: 'legacy' } }), owner, now), null);
  assert.equal(readOwnedDraft(JSON.stringify({ owner: 'b/w', savedAt: now, values: { billNo: 'foreign' } }), owner, now), null);
  assert.equal(readOwnedDraft(JSON.stringify({ owner, savedAt: now + 1, values: {} }), owner, now), null);
  assert.equal(readOwnedDraft(JSON.stringify({ owner, savedAt: now - 3_600_001, values: {} }), owner, now), null);
  assert.deepEqual(readOwnedDraft(JSON.stringify({ owner, savedAt: now, values: { billNo: '123', password: 'secret', token: 'secret' } }), owner, now), { billNo: '123' });
});

test('business writes are never replayed when the server requires login', async () => {
  let calls = 0;
  let recoveries = 0;
  warehouseSessionFence.advance();
  const stop = warehouseSessionFence.subscribe(() => { recoveries++; });
  const failure = Object.assign(new Error('expired'), { status: 401, code: 'SESSION_REQUIRED' });
  await assert.rejects(guardSessionRequest('/warehouse/v1/air-pickups', async () => { calls++; throw failure; }), failure);
  assert.equal(calls, 1);
  assert.equal(recoveries, 1);
  stop();
});

test('late response bodies are rejected before they reach a consumer', async () => {
  let finish!: (value: string) => void;
  const request = guardSessionRequest('/warehouse/v1/air-pickups', () => new Promise<string>(resolve => { finish = resolve; }));
  warehouseSessionFence.advance();
  finish('old protected details');
  await assert.rejects(request, StaleSessionResponse);
});

test('login credential errors stay in the login form and never trigger business recovery', async () => {
  let recoveries = 0;
  const stop = warehouseSessionFence.subscribe(() => { recoveries++; });
  await assert.rejects(guardSessionRequest('/warehouse/v1/sessions', async () => {
    throw Object.assign(new Error('login failed'), { status: 401, code: 'SESSION_REQUIRED' });
  }));
  assert.equal(recoveries, 0);
  stop();
});
