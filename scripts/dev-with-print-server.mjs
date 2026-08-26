import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const viteArgs = process.argv.slice(2);

// Node 24 no longer starts a `.cmd` executable directly with `shell: false`.
// Running it through cmd.exe keeps `npm run dev` reliable on Windows while the
// non-Windows path remains a direct child process.
const commandFor = args => process.platform === 'win32'
  ? {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', npmCommand, ...args]
    }
  : { command: npmCommand, args };

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
  const childCommand = commandFor(args);
  const child = spawn(childCommand.command, childCommand.args, {
    stdio: 'inherit',
    shell: false,
    cwd: process.cwd()
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
