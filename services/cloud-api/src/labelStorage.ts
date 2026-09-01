import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { type Readable } from 'node:stream';
import COS from 'cos-nodejs-sdk-v5';

export type LabelStorageObject = {
  stream: Readable;
  byteSize: number;
};

export type LabelStorage = {
  healthCheck(): Promise<void>;
  put(storageKey: string, content: Buffer): Promise<void>;
  open(storageKey: string): Promise<LabelStorageObject>;
  remove?(storageKey: string): Promise<void>;
};

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function assertStorageKey(storageKey: string): void {
  const segments = storageKey.split('/');
  if (
    !storageKey || isAbsolute(storageKey) || segments.some((segment) => (
      !segment || segment === '.' || segment === '..' || !/^[a-zA-Z0-9._-]+$/.test(segment)
    ))
  ) {
    throw new Error('Invalid private label storage key.');
  }
}

function normalizedPrefix(prefix: string): string {
  const result = prefix.replace(/^\/+|\/+$/g, '');
  if (result) assertStorageKey(result);
  return result;
}

function joinedObjectKey(prefix: string, storageKey: string): string {
  assertStorageKey(storageKey);
  const normalized = normalizedPrefix(prefix);
  return normalized ? `${normalized}/${storageKey}` : storageKey;
}

function header(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] === undefined ? undefined : String(entry[1]);
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { statusCode?: unknown; code?: unknown };
  return candidate.statusCode === 404 || candidate.code === 'NoSuchKey' || candidate.code === 'NotFound';
}

export type CosLabelStorageClient = {
  headBucket(input: { Bucket: string; Region: string }): Promise<unknown>;
  headObject(input: { Bucket: string; Region: string; Key: string }): Promise<{ headers?: Record<string, unknown> }>;
  putObject(input: {
    Bucket: string;
    Region: string;
    Key: string;
    Body: Buffer;
    ContentLength: number;
    ContentType: string;
    ACL: 'private';
    'x-cos-meta-sha256': string;
  }): Promise<unknown>;
  getObjectStream(input: { Bucket: string; Region: string; Key: string }): Readable;
  deleteObject(input: { Bucket: string; Region: string; Key: string }): Promise<unknown>;
};

export type CosLabelStorageOptions = {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
  securityToken?: string;
  prefix?: string;
};

function resolveStoragePath(root: string, storageKey: string): string {
  assertStorageKey(storageKey);
  const result = resolve(root, ...storageKey.split('/'));
  const fromRoot = relative(root, result);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || isAbsolute(fromRoot)) {
    throw new Error('Private label storage key escaped its configured root.');
  }
  return result;
}

async function assertExistingContent(path: string, expected: Buffer): Promise<void> {
  const existing = await readFile(path);
  if (existing.length !== expected.length || !timingSafeEqual(existing, expected)) {
    throw new Error('Existing content-addressed label does not match its storage key.');
  }
}

export function createFilesystemLabelStorage(rootDirectory: string): LabelStorage {
  const root = resolve(rootDirectory);
  return {
    async healthCheck() {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const metadata = await stat(root);
      if (!metadata.isDirectory()) throw new Error('Private label storage root is not a directory.');
      await access(root, constants.R_OK | constants.W_OK);
    },

    async put(storageKey, content) {
      const target = resolveStoragePath(root, storageKey);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      try {
        // A hard link publishes the already-complete temporary file atomically and never overwrites an asset.
        await link(temporary, target);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await assertExistingContent(target, content);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },

    async open(storageKey) {
      const target = resolveStoragePath(root, storageKey);
      const metadata = await stat(target);
      if (!metadata.isFile()) throw new Error('Stored label is not a file.');
      return { stream: createReadStream(target), byteSize: metadata.size };
    },

    async remove(storageKey) {
      const target = resolveStoragePath(root, storageKey);
      await unlink(target).catch(error => {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      });
    },
  };
}

export function createCosLabelStorage(
  options: CosLabelStorageOptions,
  injectedClient?: CosLabelStorageClient,
): LabelStorage {
  const client = injectedClient ?? new COS({
    SecretId: options.secretId,
    SecretKey: options.secretKey,
    SecurityToken: options.securityToken,
  }) as unknown as CosLabelStorageClient;
  const location = { Bucket: options.bucket, Region: options.region };
  const prefix = normalizedPrefix(options.prefix ?? '');

  return {
    async healthCheck() {
      await client.headBucket(location);
    },

    async put(storageKey, content) {
      const Key = joinedObjectKey(prefix, storageKey);
      const sha256 = createHash('sha256').update(content).digest('hex');
      try {
        const existing = await client.headObject({ ...location, Key });
        const existingSha256 = header(existing.headers, 'x-cos-meta-sha256');
        const existingLength = Number(header(existing.headers, 'content-length'));
        if (existingSha256 !== sha256 || existingLength !== content.length) {
          throw new Error('Existing content-addressed label does not match its storage key.');
        }
        return;
      } catch (error) {
        if (!isMissingObject(error)) throw error;
      }

      await client.putObject({
        ...location,
        Key,
        Body: content,
        ContentLength: content.length,
        ContentType: 'application/octet-stream',
        ACL: 'private',
        'x-cos-meta-sha256': sha256,
      });
    },

    async open(storageKey) {
      const Key = joinedObjectKey(prefix, storageKey);
      const metadata = await client.headObject({ ...location, Key });
      const byteSize = Number(header(metadata.headers, 'content-length'));
      if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
        throw new Error('COS object returned an invalid content length.');
      }
      return { stream: client.getObjectStream({ ...location, Key }), byteSize };
    },

    async remove(storageKey) {
      const Key = joinedObjectKey(prefix, storageKey);
      await client.deleteObject({ ...location, Key }).catch(error => {
        if (!isMissingObject(error)) throw error;
      });
    },
  };
}
