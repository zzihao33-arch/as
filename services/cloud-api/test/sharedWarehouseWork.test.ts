import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canCompleteClaim,
  completionStatus,
  createSharedWarehouseWork,
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

  it('removes private PDF bytes before deleting a shared batch and its mappings', async () => {
    const removedKeys: string[] = [];
    const executed: string[] = [];
    const connection = {
      beginTransaction: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
      execute: async (query: string) => {
        executed.push(query);
        if (query.includes('SELECT mapping_count')) return [[{ mapping_count: 2, pdf_count: 2 }]];
        if (query.includes('SELECT storage_key')) return [[
          { storage_key: 'shared-batches/batch-a/first.pdf', byte_size: 101 },
          { storage_key: 'shared-batches/batch-a/second.pdf', byte_size: 202 },
        ]];
        if (query.includes('DELETE FROM warehouse_work_batches')) return [{ affectedRows: 1 }];
        return [{ affectedRows: 1 }];
      },
    };
    const work = createSharedWarehouseWork({
      mysql: { getConnection: async () => connection } as never,
      storage: { remove: async (key: string) => { removedKeys.push(key); } } as never,
    });

    const result = await work.deleteBatch({} as never, '00000000-0000-4000-8000-000000000001');

    assert.deepEqual(removedKeys, ['shared-batches/batch-a/first.pdf', 'shared-batches/batch-a/second.pdf']);
    assert.equal(result.mappingCount, 2);
    assert.equal(result.pdfCount, 2);
    assert.equal(result.deletedStorageBytes, 303);
    assert.ok(executed.some(query => query.includes('DELETE FROM warehouse_work_batch_items')));
    assert.ok(executed.some(query => query.includes('DELETE FROM warehouse_work_batches')));
  });
});
