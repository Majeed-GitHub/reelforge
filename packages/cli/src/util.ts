/** Tiny shared plumbing for the CLI: config, API calls, prompts. */
import readline from 'node:readline';

export type ApiConfig = { apiUrl: string; apiKey: string };

export const DEFAULT_API_URL = 'http://127.0.0.1:4400/api';

export function resolveApi(flags: Record<string, string | boolean>): ApiConfig {
  const apiUrl = String(flags['api-url'] ?? process.env.REELFORGE_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const apiKey = String(flags['api-key'] ?? process.env.REELFORGE_API_KEY ?? '');
  return { apiUrl, apiKey };
}

export type ApiEnvelope<T> = { message?: string; data: T };

export async function apiCall<T>(
  config: ApiConfig,
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean } = {}
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.auth !== false && config.apiKey) headers['X-API-Key'] = config.apiKey;

  const res = await fetch(`${config.apiUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const body = parsed as { code?: string; message?: string; remediation?: { action?: string; hint?: string } } | null;
    const bits = [body?.code, body?.message].filter(Boolean).join(': ');
    const hint = body?.remediation?.hint ? `\n  ${body.remediation.hint}` : '';
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}${bits ? ` ${bits}` : ''}${hint}`);
  }
  return ((parsed as ApiEnvelope<T> | null)?.data ?? (parsed as T)) as T;
}

export function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Resolves when the operator presses Enter, or when the timeout expires. */
export function waitForEnter(timeoutMinutes: number): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      rl.close();
      resolve(false);
    }, timeoutMinutes * 60_000);
    rl.question('\n  Sign in in the browser window, then press Enter here. ', () => {
      clearTimeout(timer);
      rl.close();
      resolve(true);
    });
  });
}
