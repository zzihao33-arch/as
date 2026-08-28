import { createHash, randomBytes } from 'node:crypto';

export const integrationScopes = ['shipments:write', 'shipments:read', 'labels:write'] as const;
export type IntegrationScope = (typeof integrationScopes)[number];
export type ApiKeyEnvironment = 'live' | 'test';

export type ParsedApiKey = {
  environment: ApiKeyEnvironment;
  keyId: string;
};

export type IssuedApiKey = ParsedApiKey & {
  plaintext: string;
  prefix: string;
  hash: Buffer;
};

// randomBytes(9).toString('base64url') is always 12 characters. Keeping the ID
// length fixed makes the separator unambiguous because Base64URL may itself contain `_`.
const apiKeyPattern = /^cmh_(live|test)_([a-zA-Z0-9_-]{12})_([a-zA-Z0-9_-]{43,})$/;

export function parseApiKey(value: string): ParsedApiKey | undefined {
  const match = value.match(apiKeyPattern);
  if (!match) return undefined;
  return { environment: match[1] as ApiKeyEnvironment, keyId: match[2] };
}

export function hashApiKey(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function issueApiKey(environment: ApiKeyEnvironment): IssuedApiKey {
  const keyId = randomBytes(9).toString('base64url');
  const prefix = `cmh_${environment}_${keyId}`;
  const plaintext = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { environment, keyId, prefix, plaintext, hash: hashApiKey(plaintext) };
}

export function parseStoredScopes(value: unknown): IntegrationScope[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((scope): scope is IntegrationScope => (
    typeof scope === 'string' && integrationScopes.includes(scope as IntegrationScope)
  ));
}

export function parseScopeOption(value: string | undefined): IntegrationScope[] {
  if (!value) return [...integrationScopes];
  const requested = [...new Set(value.split(',').map((scope) => scope.trim()).filter(Boolean))];
  const invalid = requested.filter((scope) => !integrationScopes.includes(scope as IntegrationScope));
  if (invalid.length > 0 || requested.length === 0) {
    throw new Error(`Invalid scopes: ${invalid.join(', ') || '(empty)'}. Allowed: ${integrationScopes.join(', ')}`);
  }
  return requested as IntegrationScope[];
}
