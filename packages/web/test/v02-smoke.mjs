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
const calls = {
  savedProvider: null,
  savedTts: null,
  savedWebhook: null,
  tested: null,
  exportKinds: [],
  demoBodies: [],
  walkthroughRequests: 0,
  walkthroughPolls: 0,
  walkthroughRequested: false
};

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

const SHOT =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="80"><rect width="128" height="80" fill="#14171c"/><rect x="10" y="12" width="70" height="6" rx="3" fill="#2b323b"/><rect x="10" y="26" width="108" height="40" rx="6" fill="#1a2027" stroke="#2b323b"/></svg>'
  );

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
  steps: [
    {
      demo_id: 'dem_v02',
      idx: 0,
      kind: 'click',
      narration: 'Open the new project form.',
      started_at_ms: 0,
      ended_at_ms: 1400,
      selector: '[data-testid="new-project"]',
      role: 'link',
      name: 'New project',
      box_json: JSON.stringify({ x: 120, y: 240, width: 180, height: 40 }),
      url: 'http://127.0.0.1:4402/app',
      screenshot_path: null,
      screenshotUrl: SHOT
    }
  ],
  pollAfterSeconds: null
};

/** A social-framed run: the header must surface the 9:16 pill. */
const verticalDemo = {
  ...demo,
  id: 'dem_vertical',
  instruction: 'Record a vertical walkthrough of the upgrade flow.',
  duration_ms: 18300,
  options_json: JSON.stringify({ options: { language: 'en', fps: 30, aspect: '9:16', redactSensitive: true } })
};

/** A deployment whose API has no walkthrough export (POST answers 501). */
const noWalkthroughDemo = {
  ...demo,
  id: 'dem_nowalk',
  instruction: 'A demo recorded on a deployment without walkthroughs.'
};

/** The demo a submitted form creates: queued, so every output action is off. */
const queuedDemo = {
  ...demo,
  id: 'dem_new',
  status: 'queued',
  progress: 0,
  duration_ms: null,
  videoUrl: null,
  posterUrl: null,
  outcome_json: null,
  options_json: JSON.stringify({
    language: 'en',
    fps: 30,
    maxSteps: 40,
    watermark: true,
    zoom: 1.6,
    aspect: '16:9',
    redactSensitive: true
  }),
  created_at: new Date().toISOString()
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
  if (p === '/api/demos' && req.method === 'POST') {
    calls.demoBodies.push(payload);
    return json(res, 200, { message: 'Queued.', data: { id: 'dem_new', status: 'queued', pollAfterSeconds: 1 } });
  }
  if (p === '/api/demos/dem_v02') return json(res, 200, { data: demo });
  if (p === '/api/demos/dem_vertical') return json(res, 200, { data: verticalDemo });
  if (p === '/api/demos/dem_nowalk') return json(res, 200, { data: noWalkthroughDemo });
  if (p === '/api/demos/dem_new') return json(res, 200, { data: queuedDemo });
  if (p === '/api/demos/dem_v02/exports' && req.method === 'GET') {
    const list = calls.exportKinds.map((kind) => ({
      id: `exp_${kind}`,
      kind,
      status: 'complete',
      url: `/api/files/mock-${kind}-token`,
      bytes: 12345
    }));
    // The walkthrough is built asynchronously: queued on the first poll,
    // complete (with a url) on the second — exactly what the UI polls for.
    if (calls.walkthroughRequested) {
      calls.walkthroughPolls += 1;
      const complete = calls.walkthroughPolls >= 2;
      list.push({
        id: 'exp_walkthrough',
        kind: 'walkthrough',
        status: complete ? 'complete' : 'queued',
        url: complete ? '/api/files/mock-walkthrough-token' : null,
        bytes: complete ? 65432 : null
      });
    }
    return json(res, 200, { data: { exports: list } });
  }
  if (p === '/api/demos/dem_v02/exports' && req.method === 'POST') {
    calls.exportKinds.push(payload.kind);
    return json(res, 200, { data: { id: `exp_${payload.kind}`, kind: payload.kind, status: 'queued' } });
  }
  if (p === '/api/demos/dem_v02/walkthrough' && req.method === 'POST') {
    calls.walkthroughRequests += 1;
    calls.walkthroughRequested = true;
    calls.walkthroughPolls = 0;
    return json(res, 200, { message: 'Queued.', data: { id: 'exp_walkthrough', kind: 'walkthrough', status: 'queued' } });
  }
  if (p === '/api/demos/dem_nowalk/exports' && req.method === 'GET') return json(res, 200, { data: { exports: [] } });
  if (p === '/api/demos/dem_nowalk/walkthrough' && req.method === 'POST') {
    return json(res, 501, { code: 'NOT_IMPLEMENTED', message: 'Walkthrough export is not enabled on this deployment.' });
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

/** Fill and submit the new-demo form, returning the request body the API saw. */
async function submitDemo({ aspect = null, redact = null } = {}) {
  await page.goto(`${base}/app/#/demos/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#instruction', { timeout: 15000 });
  if (aspect) await page.locator('.aspect-option', { hasText: aspect }).click();
  const redactBox = page.locator('.checkrow', { hasText: 'Mask passwords, card numbers and API keys' }).locator('input');
  if (redact === true) await redactBox.check();
  if (redact === false) await redactBox.uncheck();
  await page.fill('#instruction', 'Create a project, then invite a teammate.');
  await page.getByRole('button', { name: 'Record demo', exact: true }).click();
  await page.waitForFunction(() => location.hash.includes('dem_new'), undefined, { timeout: 10000 });
  return calls.demoBodies.at(-1);
}

try {
  // ---------------------------------------------------------------- settings
  await page.goto(`${base}/app/#/settings`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Model provider', { timeout: 15000 });

  check('settings: provider section renders', await page.isVisible('text=Model provider'));
  const tiles = await page.locator('.provider-tile').count();
  check('settings: all 10 providers are listed', tiles === 10, `saw ${tiles}`);
  check('settings: offline state named honestly', await page.isVisible('text=Running fully local'));
  const groups = await page.locator('.provider-group-title').count();
  check('settings: providers are grouped (free / paid / local)', groups >= 2, `${groups} group(s)`);
  check('settings: local group explains itself', (await page.locator('text=Runs on your machine').count()) > 0);
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

  // ------------------------------------------- v0.3: output framing + privacy
  await page.goto(`${base}/app/#/demos/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#instruction');
  const aspectOptions = page.locator('.aspect-option');
  check('v0.3: new demo offers four output framings', (await aspectOptions.count()) === 4, `${await aspectOptions.count()} option(s)`);
  check(
    'v0.3: 16:9 is the default framing',
    (await page.locator('.aspect-option[aria-pressed="true"]').innerText()).includes('16:9'),
    await page.locator('.aspect-option[aria-pressed="true"]').innerText()
  );
  const redactBox = page.locator('.checkrow', { hasText: 'Mask passwords, card numbers and API keys' }).locator('input');
  check('v0.3: sensitive-data masking is on by default', await redactBox.isChecked());
  check(
    'v0.3: framing control fits the form without horizontal overflow',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  );
  const aspectWidths = await page
    .locator('.aspect-option')
    .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)));
  check(
    'v0.3: framing renders as four equal segments',
    new Set(aspectWidths).size === 1 && aspectWidths[0] > 60,
    aspectWidths.join(',')
  );
  check(
    'v0.3: privacy copy explains screenshots and video blur',
    (await page.locator('text=Screenshots are masked; the video blurs those regions while they are on screen.').count()) > 0
  );

  await page.locator('.aspect-option', { hasText: '9:16' }).click();
  await page.screenshot({ path: path.join(artifacts, 'v03-new-demo.png'), fullPage: true });

  const body16 = await submitDemo({ aspect: '16:9' });
  check('v0.3: 16:9 framing sent as options.aspect', body16?.options?.aspect === '16:9', String(body16?.options?.aspect));
  check('v0.3: redaction on by default is sent as options.redactSensitive', body16?.options?.redactSensitive === true, String(body16?.options?.redactSensitive));

  const bodyUnredacted = await submitDemo({ aspect: '16:9', redact: false });
  check(
    'v0.3: unchecking privacy sends redactSensitive=false',
    bodyUnredacted?.options?.redactSensitive === false,
    String(bodyUnredacted?.options?.redactSensitive)
  );

  const body916 = await submitDemo({ aspect: '9:16' });
  check('v0.3: 9:16 framing sent as options.aspect', body916?.options?.aspect === '9:16', String(body916?.options?.aspect));
  const body11 = await submitDemo({ aspect: '1:1' });
  check('v0.3: 1:1 framing sent as options.aspect', body11?.options?.aspect === '1:1', String(body11?.options?.aspect));
  const body45 = await submitDemo({ aspect: '4:5' });
  check('v0.3: 4:5 framing sent as options.aspect', body45?.options?.aspect === '4:5', String(body45?.options?.aspect));

  // --------------------------------------------- v0.3: aspect pill on detail
  await page.goto(`${base}/app/#/demos/dem_v02`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Share');
  const landscapeHead = await page.locator('.page-head').innerText();
  check('v0.3: 16:9 runs show no aspect pill', !landscapeHead.includes('9:16') && !landscapeHead.includes('16:9'), landscapeHead.replace(/\s+/g, ' '));

  await page.goto(`${base}/app/#/demos/dem_vertical`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Share');
  const verticalPill = page.locator('.page-head .pill').filter({ hasText: '9:16' });
  check('v0.3: non-16:9 run shows its aspect as a pill', (await verticalPill.count()) === 1);

  // -------------------------------------- v0.3: interactive walkthrough export
  await page.goto(`${base}/app/#/demos/dem_v02`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Share');
  const walkthroughBtn = page.getByRole('button', { name: 'Walkthrough', exact: true });
  const copyWalkthroughBtn = page.getByRole('button', { name: 'Copy walkthrough link', exact: true });
  check(
    'v0.3: detail header fits five output actions without overflow',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  );
  check(
    'v0.3: walkthrough actions sit with share / GIF / captions',
    (await walkthroughBtn.count()) === 1 && (await copyWalkthroughBtn.count()) === 1
  );
  check('v0.3: copy walkthrough link is disabled before a build', await copyWalkthroughBtn.isDisabled());

  await walkthroughBtn.click();
  await page.waitForFunction(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (element) => element.textContent?.trim() === 'Copy walkthrough link'
    );
    return !!button && !button.disabled;
  }, undefined, { timeout: 15000 });
  check('v0.3: walkthrough POST requested once', calls.walkthroughRequests === 1, String(calls.walkthroughRequests));
  check('v0.3: walkthrough button enables after polling finds the url', await copyWalkthroughBtn.isEnabled());
  await page.screenshot({ path: path.join(artifacts, 'v03-walkthrough.png'), fullPage: false });

  await copyWalkthroughBtn.click();
  await page.waitForSelector('text=Walkthrough link copied.', { timeout: 5000 });
  check('v0.3: copying the walkthrough link confirms', true);

  // ------------------------------- v0.3: unsupported + unfinished degradation
  await page.goto(`${base}/app/#/demos/dem_nowalk`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Share');
  await page.getByRole('button', { name: 'Walkthrough', exact: true }).click();
  await page.waitForFunction(() => {
    const button = Array.from(document.querySelectorAll('button')).find((element) => element.textContent?.trim() === 'Walkthrough');
    return !!button && button.disabled && (button.getAttribute('title') || '').includes('Not enabled');
  }, undefined, { timeout: 10000 });
  check('v0.3: a 501 walkthrough endpoint disables the action', await page.getByRole('button', { name: 'Walkthrough', exact: true }).isDisabled());
  const unsupportedTitle = await page.getByRole('button', { name: 'Walkthrough', exact: true }).getAttribute('title');
  check('v0.3: the disabled walkthrough explains why', (unsupportedTitle ?? '').includes('Not enabled on this deployment'), unsupportedTitle ?? '');

  await page.goto(`${base}/app/#/demos/dem_new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Share');
  const pendingTitle = await page.getByRole('button', { name: 'Walkthrough', exact: true }).getAttribute('title');
  check(
    'v0.3: walkthrough waits for a finished demo',
    (await page.getByRole('button', { name: 'Walkthrough', exact: true }).isDisabled()) && (pendingTitle ?? '').includes('once the demo finishes'),
    pendingTitle ?? ''
  );

  // ---------------------------------------------------------- privacy screen
  await page.goto(`${base}/app/#/demos/dem_v02`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Share');
  await page.screenshot({ path: path.join(artifacts, 'privacy-off.png'), fullPage: false });

  await page.goto(`${base}/app/#/demos`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Sign in, create a project');
  const privacyToggle = page.getByRole('button', { name: 'Privacy screen', exact: true });
  check(
    'privacy: toggle exists and is off by default',
    (await privacyToggle.count()) === 1 && (await privacyToggle.getAttribute('aria-pressed')) === 'false'
  );

  const tableHeightBefore = await page.locator('.table-wrap').evaluate((element) => element.getBoundingClientRect().height);
  await privacyToggle.click();
  await page.waitForFunction(() => document.documentElement.getAttribute('data-privacy') === 'on');
  await page.waitForSelector('.privacy-banner');
  check(
    'privacy: switching on sets data-privacy and aria-pressed',
    (await privacyToggle.getAttribute('aria-pressed')) === 'true' &&
      (await page.evaluate(() => document.documentElement.getAttribute('data-privacy'))) === 'on'
  );
  const bannerText = await page.locator('.privacy-banner').innerText();
  check('privacy: banner states the mode and the shortcut', bannerText.includes('content is masked') && bannerText.includes('Shift+P'));
  check('privacy: toggling shows a toast', await page.isVisible('text=Privacy screen on — content masked.'));
  await page.waitForFunction(() => !document.querySelector('.toast-stack'), undefined, { timeout: 6000 });
  const tableHeightAfter = await page.locator('.table-wrap').evaluate((element) => element.getBoundingClientRect().height);
  check(
    'privacy: masking does not change layout',
    Math.abs(tableHeightAfter - tableHeightBefore) <= 2,
    `${tableHeightBefore} -> ${tableHeightAfter}`
  );

  await page.goto(`${base}/app/#/demos/dem_v02`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.privacy.is-masked');
  await page.screenshot({ path: path.join(artifacts, 'privacy-on.png'), fullPage: false });

  const maskedReport = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.privacy.is-masked')).map((node) => {
      const content = node.querySelector('.privacy-content');
      return {
        text: (node.textContent || '').trim(),
        filter: content ? getComputedStyle(content).filter : getComputedStyle(node).filter,
        hasImage: !!node.querySelector('img'),
        hasVideo: !!node.querySelector('video'),
        display: getComputedStyle(node).display
      };
    })
  );
  const blurred = (entry) => typeof entry.filter === 'string' && entry.filter.includes('blur');
  check(
    'privacy: demo instruction is blurred',
    maskedReport.some((entry) => entry.text.includes('Sign in, create a project') && blurred(entry))
  );
  check('privacy: target URL is blurred', maskedReport.some((entry) => entry.text.includes('127.0.0.1') && blurred(entry)));
  check('privacy: step thumbnails are blurred', maskedReport.some((entry) => entry.hasImage && blurred(entry)));
  check('privacy: the video poster is blurred', maskedReport.some((entry) => entry.hasVideo && blurred(entry)));
  check(
    'privacy: masked content stays in the DOM and visible to layout',
    maskedReport.length >= 4 && maskedReport.every((entry) => entry.display !== 'none')
  );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedDuration = await page
    .locator('.privacy-content')
    .first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  check(
    'privacy: reduced motion removes the blur transition',
    reducedDuration.split(',').every((value) => parseFloat(value) <= 0.001),
    reducedDuration
  );
  await page.emulateMedia({ reducedMotion: null });

  const maskedInstruction = page.locator('.privacy.is-masked').filter({ hasText: 'Sign in, create a project' }).first();
  await maskedInstruction.click();
  await page.waitForFunction(() => {
    const node = Array.from(document.querySelectorAll('.privacy.is-peeking')).find((element) =>
      (element.textContent || '').includes('Sign in, create a project')
    );
    if (!node) return false;
    const content = node.querySelector('.privacy-content');
    return !!content && getComputedStyle(content).filter === 'none';
  });
  check('privacy: clicking a masked item reveals it', true);

  await page.waitForTimeout(4400);
  check(
    'privacy: it re-masks after four seconds',
    await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll('.privacy')).find((element) =>
        (element.textContent || '').includes('Sign in, create a project')
      );
      if (!node) return false;
      const content = node.querySelector('.privacy-content');
      return (
        node.classList.contains('is-masked') &&
        !node.classList.contains('is-peeking') &&
        !!content &&
        getComputedStyle(content).filter.includes('blur')
      );
    })
  );

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.privacy-banner');
  check(
    'privacy: the setting survives a reload via localStorage',
    (await page.evaluate(() => document.documentElement.getAttribute('data-privacy'))) === 'on'
  );

  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  await page.keyboard.press('Shift+P');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-privacy') !== 'on');
  check('privacy: Shift+P turns it off', (await page.evaluate(() => document.documentElement.getAttribute('data-privacy'))) === null);

  await page.keyboard.press('Shift+P');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-privacy') === 'on');
  await page.goto(`${base}/app/#/settings`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#settings-key');
  await page.locator('#settings-key').focus();
  await page.keyboard.press('Shift+P');
  await page.waitForTimeout(300);
  check(
    'privacy: Shift+P is ignored while focus is in a field',
    (await page.evaluate(() => document.documentElement.getAttribute('data-privacy'))) === 'on'
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/app/#/demos`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.privacy-banner');
  check(
    'privacy: no horizontal overflow at 390px with privacy on',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  );

  await page.getByRole('button', { name: 'Privacy screen', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.getAttribute('data-privacy') !== 'on');
  check('privacy: switching off clears every mask', (await page.locator('.privacy.is-masked').count()) === 0);

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
