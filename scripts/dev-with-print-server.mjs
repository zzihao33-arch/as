import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const viteArgs = process.argv.slice(2);

const children = [
  {
    name: 'print-server',
    args: ['run', 'server']
  },
  {
    name: 'vite',
    args: ['run', 'dev:client', '--', ...viteArgs]
  }
];

let shuttingDown = false;

const running = children.map(({ name, args }) => {
  const child = spawn(npmCommand, args, {
    stdio: 'inherit',
    shell: false
  });

  child.on('exit', code => {
    if (shuttingDown) return;

    if (code !== 0) {
      shuttingDown = true;
      running.forEach(processRef => {
        if (processRef !== child && !processRef.killed) {
          processRef.kill();
        }
      });
      process.exit(code ?? 1);
    }
  });

  child.on('error', error => {
    console.error(`[${name}] failed to start:`, error);
    process.exit(1);
  });

  return child;
});

const stopAll = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  running.forEach(child => {
    if (!child.killed) {
      child.kill();
    }
  });
};

process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});
