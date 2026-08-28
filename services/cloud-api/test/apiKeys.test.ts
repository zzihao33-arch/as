import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hashApiKey,
  issueApiKey,
  parseApiKey,
  parseScopeOption,
  parseStoredScopes,
} from '../src/apiKeys.js';

describe('integration API keys', () => {
  it('issues a key whose plaintext can be parsed and verified by hash', () => {
    const issued = issueApiKey('test');
    assert.deepEqual(parseApiKey(issued.plaintext), { environment: 'test', keyId: issued.keyId });
    assert.equal(issued.prefix, `cmh_test_${issued.keyId}`);
    assert.deepEqual(hashApiKey(issued.plaintext), issued.hash);
  });

  it('rejects malformed key shapes', () => {
    for (const value of ['', 'cmh_live_short_secret', 'cmh_prod_abcdefgh_abcdefghijklmnopqrstuvwxyz123456']) {
      assert.equal(parseApiKey(value), undefined);
    }
  });

  it('accepts only supported scopes from storage and CLI options', () => {
    assert.deepEqual(
      parseStoredScopes('["shipments:write","unknown","shipments:read"]'),
      ['shipments:write', 'shipments:read'],
    );
    assert.deepEqual(parseStoredScopes('not-json'), []);
    assert.deepEqual(parseScopeOption('shipments:read,shipments:read'), ['shipments:read']);
    assert.deepEqual(parseScopeOption(undefined), ['shipments:write', 'shipments:read', 'labels:write']);
    assert.throws(() => parseScopeOption('shipments:delete'), /Invalid scopes/);
  });
});
