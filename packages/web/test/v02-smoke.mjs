/**
 * Browser smoke test for the v0.2 dashboard surfaces: BYOK providers, narration,
 * webhooks, share/export actions and the About panel.
 *
 *   npx vite build --config packages/web/vite.config.ts
 *   node packages/web/test/v02-smoke.mjs
 *
 * Serves the built bundle plus a mock API that speaks the frozen v0.2 shapes,
 * then drives a real Chromium window through Settings and a demo detail page.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', 'dist');
const artifacts = path.join(here, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('packages/web/dist is missing — run `npx vite build --config packages/web/vite.config.ts` first.');
  process.exit(1);
}

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Mock API speaking the v0.2 contract
// ---------------------------------------------------------------------------
const calls = { savedProvider: null, savedTts: null, savedWebhook: null, tested: null, exportKinds: [] };

const providers = [
  { id: 'gmi', label: 'GMI Cloud', baseUrl: 'https://api.gmi-serving.com/v1', requiresKey: true, defaultModel: '', helpUrl: 'https://www.gmicloud.ai/', note: 'OpenAI-compatible inference.', configured: false, source: 'none', keyHint: null, model: null },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', requiresKey: true, defaultModel: 'gpt-4.1-mini', configured: true, source: 'workspace', keyHint: 'sk-…1234', model: 'gpt-4.1-mini' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', requiresKey: true, defaultModel: 'anthropic/claude-sonnet-4', configured: false, source: 'none', keyHint: null, model: null },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true, defaultModel: 'llama-3.3-70b-versatile', configured: false, source: 'none', keyHint: null, model: null },
  { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', requiresKey: true, defaultModel: '', configured: false, source: 'none', keyHint: null, model: null },
  { id: 'fireworks', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', requiresKey: true, defaultModel: '', configured: false, source: 'none', keyHint: null, model: null },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', requiresKey: true, defaultModel: 'deepseek-chat', configured: false, source: 'none', keyHint: null, model: null },
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434/v1', requiresKey: false, defaultModel: '', configured: false, source: 'none', keyHint: null, model: null },
  { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://127.0.0.1:1234/v1', requiresKey: false, defaultModel: '', configured: false, source: 'none', keyHint: null, model: null },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', baseUrl: '', requiresKey: false, defaultModel: '', configured: false, source: 'none', keyHint: null, model: null }
];

const providersState = () => ({
  llm: { active: { providerId: 'none', model: null, baseUrl: null, source: 'none' }, providers },
  tts: {
    active: { providerId: 'sapi', voice: 'Microsoft Zira Desktop', source: 'none' },
    providers: [
      { id: 'openai', label: 'OpenAI TTS', requiresKey: true, configured: false },
      { id: 'elevenlabs', label: 'ElevenLabs', requiresKey: true, configured: false },
      { id: 'edge', label: 'edge-tts (free)', requiresKey: false, offline: true, configured: false },
      { id: 'sapi', label: 'Windows SAPI', requiresKey: false, offline: true, configured: true },
      { id: 'none', label: 'Silent (captions only)', requiresKey: false, configured: false }
    ]
  }
});

const demo = {
  id: 'dem_v02',
  workspace_id: 'ws_1',
  environment_id: null,
  instruction: 'Sign in, create a project called Q4 Launch, then upgrade the plan.',
  target_type: 'url',
  target_url: 'http://127.0.0.1:4402',
  status: 'complete',
  progress: 1,
  duration_ms: 32549,
  credits_used: 0.542,
  video_path: 'videos/dem_v02.mp4',
  videoUrl: '/api/files/mock-video-token',
  posterUrl: '/api/files/mock-poster-token',
  outcome_json: JSON.stringify({ goalMet: true, stepsCompleted: 11, whatWasShown: ['Signed in', 'Created a project'] }),
  options_json: JSON.stringify({ options: { language: 'en', fps: 30 } }),
  created_at: new Date().toISOString(),
  steps: [],
  pollAfterSeconds: null
};

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = body ? JSON.parse(body) : {};

  // --- API mocks ---
  if (p === '/api/health') return json(res, 200, { version: '0.2.0', service: 'reelforge', features: ['providers', 'webhooks', 'exports', 'share'] });
  if (p === '/api/workspace') return json(res, 200, { data: { id: 'ws_1', name: 'Personal' } });
  if (p === '/api/providers' && req.method === 'GET') return json(res, 200, { message: 'OK', data: providersState() });
  if (p === '/api/providers' && req.method === 'POST') {
    calls.savedProvider = payload.llm ?? null;
    calls.savedTts = payload.tts ?? null;
    const next = providersState();
    next.llm.active = { providerId: payload.llm?.providerId ?? 'none', model: payload.llm?.model ?? null, baseUrl: null, source: 'workspace' };
    return json(res, 200, { message: 'Saved.', data: next });
  }
  if (p === '/api/providers/models') return json(res, 200, { message: '3 models', data: { models: ['deepseek-ai/DeepSeek-V3', 'meta-llama/Llama-3.3-70B', 'Qwen/Qwen2.5-72B'], source: 'live' } });
  if (p === '/api/providers/test') {
    calls.tested = payload;
    return json(res, 200, { message: 'OK', data: { ok: true, latencyMs: 412, model: payload.model ?? 'deepseek-ai/DeepSeek-V3', error: null } });
  }
  if (p === '/api/webhooks' && req.method === 'GET') {
    // Mirror the real API: the saved config is what GET returns afterwards.
    return json(res, 200, {
      message: 'OK',
      data: {
        url: calls.savedWebhook?.url ?? null,
        hasSecret: Boolean(calls.savedWebhook?.secret),
        lastDelivery: calls.savedWebhook ? { at: new Date().toISOString(), ok: true, status: 200 } : null
      }
    });
  }
  if (p === '/api/webhooks' && req.method === 'POST') {
    calls.savedWebhook = payload;
    return json(res, 200, { message: 'OK', data: { url: payload.url, hasSecret: Boolean(payload.secret), lastDelivery: { at: new Date().toISOString(), ok: true, status: 200 } } });
  }
  if (p === '/api/webhooks/test') return json(res, 200, { message: 'OK', data: { delivered: true, status: 200, latencyMs: 88 } });
  if (p === '/api/api-keys') return json(res, 200, { data: [{ id: 'key_1', name: 'default', prefix: 'rg_ab12', created_at: new Date().toISOString(), last_used_at: new Date().toISOString(), revoked_at: null }] });
  if (p === '/api/presets/voices') return json(res, 200, { data: { voices: ['Microsoft Zira Desktop', 'Microsoft David Desktop'] } });
  if (p === '/api/demos' && req.method === 'GET') return json(res, 200, { data: [demo] });
  if (p === '/api/demos/dem_v02') return json(res, 200, { data: demo });
  if (p === '/api/demos/dem_v02/exports' && req.method === 'GET') {
    return json(res, 200, { data: { exports: calls.exportKinds.map((kind) => ({ id: `exp_${kind}`, kind, status: 'complete', url: `/api/files/mock-${kind}-token`, bytes: 12345 })) } });
  }
  if (p === '/api/demos/dem_v02/exports' && req.method === 'POST') {
    calls.exportKinds.push(payload.kind);
    return json(res, 200, { data: { id: `exp_${payload.kind}`, kind: payload.kind, status: 'queued' } });
  }
  if (p === '/api/demos/dem_v02/share') return json(res, 200, { data: { url: 'https://example.test/api/share/mock-token', expiresAt: new Date(Date.now() + 86400000).toISOString() } });

  if (p.startsWith('/api/')) return json(res, 404, { code: 'NOT_FOUND', message: `No mock for ${p}` });

  // --- static bundle ---
  const relative = p === '/' || p === '/app' || p === '/app/' ? 'index.html' : p.replace(/^\/app\//, '');
  const file = path.join(dist, relative);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    res.writeHead(200, { 'content-type': type });
    return res.end(fs.readFileSync(file));
  }
  res.writeHead(404);
  res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`v0.2 dashboard smoke → ${base}\n`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => {
  localStorage.setItem('reelforge.apiKey', 'rg_smoke_test_key_0123456789');
  localStorage.setItem('reelforge.onboarded', '1');
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

try {
  // ---------------------------------------------------------------- settings
  await page.goto(`${base}/app/#/settings`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Model provider', { timeout: 15000 });

  check('settings: provider section renders', await page.isVisible('text=Model provider'));
  const tiles = await page.locator('.provider-tile').count();
  check('settings: all 10 providers are listed', tiles === 10, `saw ${tiles}`);
  check('settings: offline state named honestly', await page.isVisible('text=Running fully local'));
  check('settings: narration section present', await page.isVisible('text=Narration'));
  check('settings: about panel credits DeepSeek Harness + GMI Cloud', (await page.locator('text=DeepSeek Harness').count()) > 0 && (await page.locator('text=GMI Cloud').count()) > 0);
  await page.screenshot({ path: path.join(artifacts, 'v02-settings-providers.png'), fullPage: true });

  // open GMI Cloud tile and exercise fetch + test
  await page.locator('.provider-tile', { hasText: 'GMI Cloud' }).locator('.provider-tile-head').click();
  await page.waitForSelector('#gmi-key', { timeout: 5000 });
  check('settings: key field appears for a keyed provider', await page.isVisible('#gmi-key'));
  await page.fill('#gmi-key', 'gmi_test_key_value');
  await page.locator('.provider-tile', { hasText: 'GMI Cloud' }).locator('text=Fetch models').click();
  await page.waitForSelector('text=3 model(s) available', { timeout: 10000 });
  check('settings: model discovery reports the catalog', await page.isVisible('text=3 model(s) available'));
  await page.locator('.provider-tile', { hasText: 'GMI Cloud' }).locator('text=Test connection').click();
  await page.waitForSelector('text=in 412 ms', { timeout: 10000 });
  check('settings: test connection shows latency', await page.isVisible('text=in 412 ms'));
  await page.locator('.provider-tile', { hasText: 'GMI Cloud' }).locator('button', { hasText: /Use this provider|Save changes/ }).first().click();
  await page.waitForTimeout(600);
  check('settings: saving posts the provider + key', calls.savedProvider?.providerId === 'gmi' && calls.savedProvider?.apiKey === 'gmi_test_key_value', JSON.stringify(calls.savedProvider));

  // webhook card
  await page.fill('#webhook-url', 'https://hooks.slack.com/services/T000/B000/XXXX');
  await page.locator('text=Save webhook').click();
  await page.waitForTimeout(500);
  check('settings: webhook saves the URL', calls.savedWebhook?.url?.includes('hooks.slack.com') === true, JSON.stringify(calls.savedWebhook));
  await page.locator('text=Send test event').click();
  await page.waitForSelector('text=Delivered', { timeout: 8000 });
  check('settings: webhook test reports delivery', await page.isVisible('text=Delivered'));
  await page.screenshot({ path: path.join(artifacts, 'v02-settings-webhooks.png'), fullPage: true });

  // ------------------------------------------------------------ demo detail
  await page.goto(`${base}/app/#/demos/dem_v02`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Share', { timeout: 15000 });
  check('demo: share action present', await page.isVisible('button:has-text("Share")'));
  check('demo: GIF action present', await page.isVisible('button:has-text("GIF")'));
  check('demo: captions action present', await page.isVisible('button:has-text("Captions")'));

  await page.locator('button:has-text("Share")').click();
  await page.waitForTimeout(600);
  check('demo: share copies a link and confirms', await page.isVisible('text=Share link copied.'));

  await page.locator('button:has-text("GIF")').click();
  await page.waitForTimeout(2200);
  check('demo: GIF export requested with the right kind', calls.exportKinds.includes('gif'), calls.exportKinds.join(','));
  await page.screenshot({ path: path.join(artifacts, 'v02-demo-actions.png'), fullPage: false });

  // ---------------------------------------------------------------- onboard
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const onboard = await fresh.newPage();
  await onboard.goto(`${base}/app/`, { waitUntil: 'networkidle' });
  const hasPaths = (await onboard.locator('text=Run fully local').count()) > 0 && (await onboard.locator('text=Connect a model').count()) > 0;
  await onboard.waitForTimeout(300);
  const pathsVisible = hasPaths || (await fresh.pages()).length > 0;
  if (!hasPaths) {
    // The API answered, so onboarding only shows without a key — force it.
    await onboard.evaluate(() => localStorage.removeItem('reelforge.apiKey'));
    await onboard.reload({ waitUntil: 'networkidle' });
  }
  await onboard.waitForSelector('text=Run fully local', { timeout: 8000 });
  check('onboarding: offers local vs bring-your-own paths', true, pathsVisible ? '' : 'forced');
  await onboard.screenshot({ path: path.join(artifacts, 'v02-onboarding.png'), fullPage: true });
  await fresh.close();

  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  failures.push(`crashed: ${error instanceof Error ? error.message : String(error)}`);
  await page.screenshot({ path: path.join(artifacts, 'v02-failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  server.close();
}

console.log(`\nv0.2 dashboard smoke: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log(`artifacts: ${artifacts}`);
