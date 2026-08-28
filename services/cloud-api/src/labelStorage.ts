import { constants, createReadStream, type ReadStream } from 'node:fs';
import { access, link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type LabelStorageObject = {
  stream: ReadStream;
  byteSize: number;
};

export type LabelStorage = {
  healthCheck(): Promise<void>;
  put(storageKey: string, content: Buffer): Promise<void>;
  open(storageKey: string): Promise<LabelStorageObject>;
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
  };
}
