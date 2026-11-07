#!/usr/bin/env node
/**
 * One command to bring the whole stack up locally:
 *   npm run dev
 *
 * demo site :4402   (the product being demoed)
 * API+worker:4400   (REST, MCP, job queue)
 * dashboard :4401   (Vite dev server, proxies /api -> :4400)
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORTS = {
  api: Number(process.env.REELFORGE_API_PORT ?? 4400),
  web: Number(process.env.REELFORGE_WEB_PORT ?? 4401),
  demo: Number(process.env.REELFORGE_DEMO_PORT ?? 4402)
};

const procs = [];
let shuttingDown = false;

/**
 * On Windows `child.kill()` kills only the direct child; npm/vite spawn
 * grandchildren that keep the port bound. taskkill /T takes the whole tree.
 */
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function run(name, command, args) {
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `[${name}]`.padEnd(12);
  const tag = (line) => `${prefix} ${line}`;
  child.stdout.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => console.log(tag(l))));
  child.stderr.on('data', (b) =>
    String(b)
      .split('\n')
      .filter(Boolean)
      .forEach((l) => {
        if (/DEP0190|ExperimentalWarning|trace-deprecation|\.env not found/.test(l)) return;
        console.error(tag(l));
      })
  );
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(tag(`exited with code ${code}`));
      shutdown(code ?? 1);
    }
  });
  procs.push({ name, child });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of procs) killTree(child);
  setTimeout(() => process.exit(code), 700);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  const busy = [];
  for (const [name, port] of Object.entries(PORTS)) {
    if (!(await portFree(port))) busy.push(`${name} :${port}`);
  }
  if (busy.length > 0) {
    console.error(
      `\n✖ Port(s) already in use: ${busy.join(', ')}.\n` +
        '  Something is still running from a previous session (often a demo-site or API\n' +
        '  started by `npm run smoke`). Stop it, or use different ports:\n' +
        '    $env:REELFORGE_API_PORT=5400; $env:REELFORGE_WEB_PORT=5401; $env:REELFORGE_DEMO_PORT=5402; npm run dev\n'
    );
    process.exit(1);
  }

  console.log('Starting Reelforge…\n');
  run('demo-site', process.execPath, ['apps/demo-site/server.ts']);
  run('api', process.execPath, ['--env-file-if-exists=.env', 'packages/api/src/server.ts']);
  run('web', process.execPath, [
    path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config',
    'packages/web/vite.config.ts',
    '--port',
    String(PORTS.web)
  ]);

  console.log(`
  demo site   http://127.0.0.1:${PORTS.demo}
  API + MCP   http://127.0.0.1:${PORTS.api}/api
  dashboard   http://127.0.0.1:${PORTS.web}
`);
}

main().catch((error) => {
  console.error(error);
  shutdown(1);
});
