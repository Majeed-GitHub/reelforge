/**
 * `reelforge session` — capture a signed-in browser session.
 *
 * Logs into YOUR product in a real browser (Google SSO, Okta, 2FA push, magic
 * link — anything that ends with you signed in), then uploads the resulting
 * session (cookies, localStorage, IndexedDB). Reelforge never receives your
 * password, and the stored session is encrypted at rest by the API.
 */
import { chromium } from 'playwright';
import { apiCall, resolveApi, waitForEnter } from './util.ts';

type ResolvedTarget = { id: string; name: string; baseUrl: string };

function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

export async function runSession(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const config = resolveApi(flags);
  const code = str(flags, 'code') ?? args[0];
  const environmentFlag = str(flags, 'environment');
  const name = str(flags, 'name');
  const baseUrl = str(flags, 'base-url');
  const timeoutMinutes = Number(str(flags, 'timeout') ?? '10');

  console.log(`\nReelforge API: ${config.apiUrl}`);

  if (!code && !config.apiKey) {
    throw new Error(
      'Nothing to sign in with.\n\n' +
        '  Ask the dashboard for a login code, then run:\n' +
        '      reelforge session DIR-XXXX-XXXX-XXXX\n\n' +
        '  (For CI without a human: pass --api-key and --environment.)'
    );
  }
  if (!code && !environmentFlag && !(name && baseUrl)) {
    throw new Error('Pass a login code, or --environment <id>, or --name with --base-url.');
  }

  // Fail before opening a browser if this deployment can't store the capture.
  try {
    const health = await apiCall<{ version?: string; features?: string[] }>(config, '/health', { auth: false });
    const features = health?.features ?? [];
    const missing = ['environments'].filter((f) => !features.includes(f));
    if (features.length > 0 && missing.length > 0) {
      throw new Error(`${config.apiUrl} does not support: ${missing.join(', ')}. Nothing was sent.`);
    }
    console.log(`Health: version ${health?.version ?? 'unknown'}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not support')) throw error;
    console.log('Health: unavailable (continuing)');
  }

  const target: ResolvedTarget = code
    ? await apiCall<{ environmentId: string; name: string; baseUrl: string }>(
        config,
        `/environments/by-code/${encodeURIComponent(code)}`,
        { auth: false }
      ).then((t) => ({ id: t.environmentId, name: t.name, baseUrl: t.baseUrl }))
    : environmentFlag
      ? await apiCall<{ id: string; name: string; baseUrl: string }>(config, `/environments/${encodeURIComponent(environmentFlag)}`)
      : await apiCall<{ id: string; name: string; baseUrl: string }>(config, '/environments', {
          method: 'POST',
          body: { name, baseUrl }
        });

  const startUrl = str(flags, 'start-url') ?? target.baseUrl;
  console.log(
    `Environment:  ${target.name ?? target.id}\n\nOpening ${startUrl}\n` +
      '  Sign in exactly as you normally would — SSO, 2FA, magic link, all fine.\n' +
      '  Reelforge never sees your password; only the session that results.\n'
  );

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(startUrl).catch(() => {
    console.error(`\n  (could not load ${startUrl} — navigate manually)\n`);
  });

  const confirmed = await waitForEnter(timeoutMinutes);
  if (!confirmed) {
    await browser.close();
    throw new Error(`Timed out after ${timeoutMinutes} minutes. Nothing was saved.`);
  }

  // indexedDB is not optional: Firebase and Supabase keep auth material there,
  // so a cookie-only capture of those apps uploads a logged-out session.
  const storageState = await context.storageState({ indexedDB: true });
  await browser.close();

  if (storageState.cookies.length === 0 && storageState.origins.length === 0) {
    throw new Error('The browser had no cookies or stored data — it does not look like a sign-in completed. Nothing was saved.');
  }

  const uploadPath = code
    ? `/environments/by-code/${encodeURIComponent(code)}/session`
    : `/environments/${encodeURIComponent(target.id)}/session`;

  await apiCall(config, uploadPath, { method: 'POST', body: { storageState }, auth: !code });

  console.log(
    `\n✔ Session saved to environment ${target.id}\n` +
      `  ${storageState.cookies.length} cookie(s), ${storageState.origins.length} origin(s)\n` +
      '\n  Demos on this product will now sign in with it, off camera.\n'
  );
}
