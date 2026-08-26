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

const services = [
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
const running = new Map();
const restartTimers = new Map();
const RESTART_DELAY_MS = 1_500;

const scheduleRestart = service => {
  if (shuttingDown || restartTimers.has(service.name)) return;

  console.error(`[${service.name}] exited unexpectedly; retrying in ${RESTART_DELAY_MS / 1_000}s without stopping the local web page.`);
  const restartTimer = setTimeout(() => {
    restartTimers.delete(service.name);
    if (!shuttingDown) startService(service);
  }, RESTART_DELAY_MS);

  restartTimers.set(service.name, restartTimer);
};

const startService = service => {
  const childCommand = commandFor(service.args);
  const child = spawn(childCommand.command, childCommand.args, {
    stdio: 'inherit',
    shell: false,
    cwd: process.cwd()
  });

  running.set(service.name, child);

  let restartRequested = false;
  const requestRestart = () => {
    if (restartRequested || shuttingDown) return;
    restartRequested = true;
    if (running.get(service.name) === child) running.delete(service.name);
    scheduleRestart(service);
  };

  child.on('exit', requestRestart);

  child.on('error', error => {
    console.error(`[${service.name}] failed to start:`, error);
    requestRestart();
  });

  return child;
};

services.forEach(startService);

const stopAll = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  restartTimers.forEach(timer => clearTimeout(timer));
  restartTimers.clear();
  running.forEach(child => {
    if (!child.killed) {
      child.kill();
    }
  });
  running.clear();
};

process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});
