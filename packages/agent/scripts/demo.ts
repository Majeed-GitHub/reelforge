/**
 * Shared demo-site lifecycle for the verification scripts.
 *
 * Starts apps/demo-site on port 4402 if nothing is listening, waits for
 * /healthz, and exposes /reset so every run starts from the seeded state
 * (two projects, Free plan, signed out).
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { DEMO_SITE_PORT, ROOT } from '../../core/src/config.ts';

export const BASE_URL = `http://127.0.0.1:${DEMO_SITE_PORT}`;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function healthy(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForHealth(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await sleep(200);
  }
  throw new Error(`demo site did not become healthy at ${BASE_URL} within ${timeoutMs}ms`);
}

/** Start the demo site unless one is already listening. Returns the child when we own it. */
export async function startDemoSite(): Promise<ChildProcess | null> {
  if (await healthy()) {
    console.log(`[demo] demo site already running at ${BASE_URL}`);
    return null;
  }
  console.log(`[demo] starting demo site: node apps/demo-site/server.ts (port ${DEMO_SITE_PORT})`);
  const child = spawn(process.execPath, ['apps/demo-site/server.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env }
  });
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) console.error(`[demo] demo site exited unexpectedly (code ${code}, signal ${signal})`);
  });
  await waitForHealth();
  return child;
}

export async function stopDemoSite(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill();
  const deadline = Date.now() + 4000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

/** Reset in-memory demo state (seeded projects, Free plan, signed out). */
export async function resetDemoSite(): Promise<void> {
  const response = await fetch(`${BASE_URL}/reset`, { redirect: 'follow' });
  if (!response.ok) throw new Error(`GET /reset returned HTTP ${response.status}`);
  console.log('[demo] state reset');
}
