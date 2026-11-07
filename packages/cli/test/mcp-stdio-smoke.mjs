/**
 * Drives the MCP stdio bridge exactly as a stdio-only client would.
 *
 *   node packages/cli/test/mcp-stdio-smoke.mjs
 *
 * Boots the API on :4415, starts `mcp-stdio.ts --stdio`, then speaks JSON-RPC
 * over its stdin/stdout: initialize, tools/list, and one tools/call. This is the
 * path Claude Desktop uses, so it is worth testing the wire and not just the code.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = Number(process.env.REELFORGE_STDIO_TEST_PORT ?? 4415);
const API = `http://127.0.0.1:${PORT}/api`;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function readKey() {
  const file = path.join(ROOT, 'data', 'dev-api-key.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  throw new Error('No API key. Run `npm run seed` first.');
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

const api = spawn(process.execPath, ['packages/api/src/server.ts'], {
  cwd: ROOT,
  env: { ...process.env, REELFORGE_API_PORT: String(PORT), REELFORGE_LOG_LEVEL: 'warn', REELFORGE_TTS_PROVIDER: 'none' },
  stdio: ['ignore', 'ignore', 'pipe']
});
let apiErr = '';
api.stderr.on('data', (b) => (apiErr += String(b)));

const bridge = { child: null, stderr: '' };
try {
  const up = await waitFor(`${API}/health`);
  check('API boots', up, API);
  if (!up) throw new Error(`API did not start: ${apiErr.slice(-600)}`);

  const key = readKey();
  const proc = spawn(
    process.execPath,
    ['packages/cli/src/mcp-stdio.ts', '--stdio', '--api-url', API, '--api-key', key],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  bridge.child = proc;
  proc.stderr.on('data', (b) => (bridge.stderr += String(b)));

  const responses = new Map();
  const pending = new Set();
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('{')) continue;
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) {
          responses.set(message.id, message);
          pending.delete(message.id);
        }
      } catch {
        /* not a protocol line we care about */
      }
    }
  });

  const send = (message) => {
    if (message.id !== undefined) pending.add(message.id);
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const waitForResponse = async (id, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (responses.has(id)) return responses.get(id);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`No response for id ${id}. stderr:\n${bridge.stderr.slice(-1200)}`);
  };

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-smoke', version: '1' } }
  });
  const init = await waitForResponse(1);
  check('initialize answers', init.result?.serverInfo?.name === 'reelforge', JSON.stringify(init.result?.serverInfo ?? {}));

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = await waitForResponse(2);
  const toolList = tools.result?.tools ?? [];
  check('tools/list is proxied', toolList.length >= 20, `${toolList.length} tools`);
  check('tool names are snake_case', toolList.every((tool) => /^[a-z0-9_]+$/.test(tool.name)), toolList.slice(0, 3).map((t) => t.name).join(', '));
  check('tool descriptions are present', toolList.every((tool) => typeof tool.description === 'string' && tool.description.length > 20));

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_demos', arguments: {} } });
  const call = await waitForResponse(3);
  check('tools/call is proxied', Array.isArray(call.result?.content) && call.result.content.length > 0, JSON.stringify(call.result ?? call.error ?? {}).slice(0, 160));
  check('call does not report an error', call.result?.isError !== true);

  send({ jsonrpc: '2.0', id: 4, method: 'prompts/list' });
  const prompts = await waitForResponse(4, 10_000).catch(() => null);
  check('prompts/list does not break the bridge', prompts !== null && (prompts.result !== undefined || prompts.error !== undefined));

  proc.stdin.end();
  await new Promise((resolve) => setTimeout(resolve, 400));
} catch (error) {
  check('bridge run', false, error instanceof Error ? error.message : String(error));
} finally {
  killTree(bridge.child);
  killTree(api);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\nmcp stdio smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const failure of failed) console.log(`  - ${failure.name}: ${failure.detail}`);
  process.exit(1);
}
