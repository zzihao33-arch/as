import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const PASSWORD_BYTES = 32;
const SESSION_KEY_ID_LENGTH = 12;
const SESSION_SECRET_LENGTH = 43;
const SESSION_PATTERN = /^cmh_ws_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$/;

export type ParsedWarehouseSessionToken = { keyId: string };

function encode(value: Buffer): string {
  return value.toString('base64url');
}

function derive(password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, { ...options, maxmem: 64 * 1024 * 1024 }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

export function normalizeWarehouseEmail(value: string): string {
  return value.trim().toLowerCase();
}

export async function hashWarehousePassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derive(password, salt, PASSWORD_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${encode(salt)}$${encode(derived)}`;
}

export async function verifyWarehousePassword(password: string, encodedHash: string): Promise<boolean> {
  const [algorithm, n, r, p, encodedSalt, encodedDerived] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || !n || !r || !p || !encodedSalt || !encodedDerived) return false;
  const salt = Buffer.from(encodedSalt, 'base64url');
  const expected = Buffer.from(encodedDerived, 'base64url');
  const derived = await derive(password, salt, expected.length, {
    N: Number(n), r: Number(r), p: Number(p),
  }).catch(() => Buffer.alloc(0));
  return expected.length > 0 && derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function createWarehouseSessionToken(): { token: string; keyId: string; tokenHash: Buffer } {
  const keyId = encode(randomBytes(9));
  const secret = encode(randomBytes(32));
  if (keyId.length !== SESSION_KEY_ID_LENGTH || secret.length !== SESSION_SECRET_LENGTH) {
    throw new Error('Unable to create a warehouse session token.');
  }
  const token = `cmh_ws_${keyId}_${secret}`;
  return { token, keyId, tokenHash: hashWarehouseSessionToken(token) };
}

export function parseWarehouseSessionToken(token: string): ParsedWarehouseSessionToken | null {
  const match = SESSION_PATTERN.exec(token);
  return match ? { keyId: match[1] } : null;
}

export function hashWarehouseSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
