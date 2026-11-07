/** `reelforge doctor` — read-only checks, tells you what to fix. Fixes nothing. */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { apiCall, resolveApi } from './util.ts';

type Check = { ok: boolean | null; label: string; detail: string };

export async function runDoctor(flags: Record<string, string | boolean>): Promise<void> {
  const config = resolveApi(flags);
  const checks: Check[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    ok: major >= 22,
    label: 'Node.js',
    detail: `v${process.versions.node}${major >= 22 ? '' : ' (need >= 22.6 for TypeScript type stripping)'}`
  });

  let chromiumOk = false;
  let chromiumPath = '';
  try {
    chromiumPath = chromium.executablePath();
    chromiumOk = fs.existsSync(chromiumPath);
  } catch {
    chromiumOk = false;
  }
  if (chromiumOk) {
    // existsSync lies if the download is half-finished; try a real launch.
    try {
      const browser = await chromium.launch({ headless: true });
      await browser.close();
    } catch {
      chromiumOk = false;
    }
  }
  checks.push({
    ok: chromiumOk,
    label: 'Playwright Chromium',
    detail: chromiumOk ? 'installed and launches' : 'missing — run `reelforge init`'
  });

  checks.push({
    ok: config.apiKey ? true : null,
    label: 'REELFORGE_API_KEY',
    detail: config.apiKey ? 'set' : 'not set — needed for `reelforge mcp` and CI session capture'
  });

  try {
    const health = await apiCall<{ version?: string; features?: string[] }>(config, '/health', { auth: false });
    checks.push({
      ok: true,
      label: 'Reelforge API',
      detail: `${config.apiUrl} reachable (version ${health?.version ?? 'unknown'}, features: ${(health?.features ?? []).join(', ') || 'none'})`
    });
  } catch (error) {
    checks.push({
      ok: false,
      label: 'Reelforge API',
      detail: `${config.apiUrl} unreachable — ${error instanceof Error ? error.message : error}`
    });
  }

  if (config.apiKey) {
    try {
      const demos = await apiCall<unknown[]>(config, '/demos?limit=1');
      checks.push({ ok: true, label: 'API key', detail: `accepted (${Array.isArray(demos) ? demos.length : 0} recent demo(s))` });
    } catch (error) {
      checks.push({
        ok: false,
        label: 'API key',
        detail: `rejected — ${error instanceof Error ? error.message : error}`
      });
    }
  }

  console.log('\nReelforge CLI doctor\n');
  for (const check of checks) {
    const mark = check.ok === true ? '✔' : check.ok === false ? '✖' : '–';
    console.log(`  ${mark} ${check.label}: ${check.detail}`);
  }
  const failures = checks.filter((c) => c.ok === false).length;
  const warnings = checks.filter((c) => c.ok === null).length;
  console.log(`\n${checks.filter((c) => c.ok === true).length} ok, ${warnings} warning(s), ${failures} failure(s)\n`);
  if (failures) process.exitCode = 1;
}
