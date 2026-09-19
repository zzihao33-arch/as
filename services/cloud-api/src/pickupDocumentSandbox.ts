import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { DocumentChecker } from './pickupDocumentPolicy.js';

type SandboxReply = { protocol: number; sourceSha256: string; clean: boolean; validated: boolean; contentType: string; errorCode?: string };
const MAX_HEADER_BYTES = 8192;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const unavailable = () => new Error('DOCUMENT_CHECK_UNAVAILABLE');

export function decodeDocumentCheckReply(frame: Buffer, sourceHash: string, contentType: string) {
  const newline = frame.indexOf(10);
  if (newline < 0 || newline > MAX_HEADER_BYTES) throw unavailable();
  let reply: SandboxReply;
  try { reply = JSON.parse(frame.subarray(0, newline).toString('utf8')) as SandboxReply; }
  catch { throw unavailable(); }
  if (!reply || reply.protocol !== 1 || reply.sourceSha256 !== sourceHash || reply.contentType !== contentType) throw unavailable();
  if (frame.length !== newline + 1) throw unavailable();
  if (reply.clean === true && reply.validated === true) return { clean: true, validated: true, contentType };
  if (reply.clean !== false || reply.validated !== false) throw unavailable();
  if (reply.errorCode === 'SCANNER_UNAVAILABLE') throw unavailable();
  if (!['INVALID', 'ACTIVE_CONTENT', 'LIMIT'].includes(reply.errorCode ?? '')) throw unavailable();
  return { clean: false, validated: false, contentType };
}

export function buildDocumentCheckerArgs(image: string, containerName: string) {
  if (!/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(image)) throw new Error('PICKUP_DOCUMENT_SANDBOX_IMAGE must be an immutable sha256 image reference');
  if (!/^cmhub-document-[0-9a-f-]{36}$/.test(containerName)) throw new Error('invalid document checker container name');
  return ['run', '--rm', '--pull=never', '--log-driver=none', '-i', '--name', containerName, '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--user=65532:65532', '--memory=2g', '--memory-swap=2g', '--cpus=1', '--pids-limit=64',
    '--ulimit=nofile=256:256', '--tmpfs=/work:rw,noexec,nosuid,size=268435456,mode=1777', '--env=HOME=/work', '--env=TMPDIR=/work', image];
}

export function createPickupDocumentChecker(options: { image: string; dockerPath?: string; timeoutMs?: number }) {
  if (!/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(options.image)) throw new Error('PICKUP_DOCUMENT_SANDBOX_IMAGE must be an immutable sha256 image reference');
  const docker = options.dockerPath ?? 'docker';
  let busy = false;
  let unavailableAdapter = false;

  const checker: DocumentChecker = async (bytes, contentType, signal) => {
    if (signal.aborted || unavailableAdapter || busy || bytes.length === 0 || bytes.length > MAX_FILE_BYTES) throw unavailable();
    busy = true;
    const name = `cmhub-document-${randomUUID()}`;
    const args = buildDocumentCheckerArgs(options.image, name);
    const sourceHash = createHash('sha256').update(bytes).digest('hex');
    try {
      const response = await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(docker, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        const cleanupContainer = () => new Promise<void>(done => {
          const cleanup = spawn(docker, ['rm', '-f', name], { shell: false, windowsHide: true, stdio: 'ignore' });
          const timer = setTimeout(() => { unavailableAdapter = true; cleanup.kill(); done(); }, 5000);
          cleanup.on('error', () => { unavailableAdapter = true; clearTimeout(timer); done(); });
          cleanup.on('close', code => { if (code !== 0) unavailableAdapter = true; clearTimeout(timer); done(); });
        });
        const clear = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
        const fail = (cause: Error) => {
          if (settled) return;
          settled = true;
          unavailableAdapter = true;
          clear();
          const closed = new Promise<void>(done => {
            if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
            const stop = setTimeout(done, 5000);
            child.once('close', () => { clearTimeout(stop); done(); });
          });
          child.kill();
          void Promise.allSettled([closed, cleanupContainer()]).then(() => reject(cause));
        };
        const abort = () => fail(unavailable());
        const timer = setTimeout(abort, options.timeoutMs ?? 30000);
        signal.addEventListener('abort', abort, { once: true });
        child.on('error', () => fail(unavailable()));
        child.stdout.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_HEADER_BYTES + 1) { fail(unavailable()); return; }
          chunks.push(chunk);
        });
        child.stderr.on('data', () => { /* Drain without retaining private document text or paths. */ });
        child.stdin.on('error', () => fail(unavailable()));
        child.on('close', code => {
          if (settled) return;
          settled = true;
          clear();
          if (code !== 0) { unavailableAdapter = true; reject(unavailable()); return; }
          resolve(Buffer.concat(chunks, total));
        });
        child.stdin.write(JSON.stringify({ protocol: 1, mode: 'check', contentType, byteSize: bytes.length, sha256: sourceHash }) + '\n');
        child.stdin.end(bytes);
      });
      return decodeDocumentCheckReply(response, sourceHash, contentType);
    } finally { busy = false; }
  };
  return checker;
}
