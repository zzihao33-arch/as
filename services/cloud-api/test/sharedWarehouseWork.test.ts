import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canCompleteClaim,
  completionStatus,
  mappedTrackingNumbers,
} from '../src/sharedWarehouseWork.js';

describe('shared warehouse work safety rules', () => {
  it('checks an intercept against both sides of a tracking mapping', () => {
    assert.deepEqual(mappedTrackingNumbers('FIRST123', 'COURIER456'), ['FIRST123', 'COURIER456']);
    assert.deepEqual(mappedTrackingNumbers('FIRST123', null), ['FIRST123']);
  });

  it('accepts a delayed audit only while the original claim still owns the item', () => {
    const claim = { claimToken: 'claim-a', workstationId: 'station-a' };
    assert.equal(canCompleteClaim(claim, 'claim-a', 'station-a'), true);
    assert.equal(canCompleteClaim(claim, 'claim-b', 'station-a'), false);
    assert.equal(canCompleteClaim(claim, 'claim-a', 'station-b'), false);
  });

  it('keeps an unknown QZ result terminal instead of silently making it printable again', () => {
    assert.equal(completionStatus('SUBMITTED'), 'SUBMITTED');
    assert.equal(completionStatus('RESULT_UNKNOWN'), 'RESULT_UNKNOWN');
    assert.equal(completionStatus('BLOCKED'), 'BLOCKED');
    assert.equal(completionStatus('FAILED'), 'FAILED');
  });
});
