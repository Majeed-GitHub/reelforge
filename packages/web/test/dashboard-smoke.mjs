/**
 * Browser smoke test for the dashboard.
 *
 *   npx vite build --config packages/web/vite.config.ts
 *   node packages/web/test/dashboard-smoke.mjs
 *
 * Serves the *built* bundle at /app plus a mock Reelforge API at /api (the
 * shapes api-dev confirmed), then drives a real Chromium window through every
 * screen: demos table, demo detail (steps/transcript/raw, question, failure),
 * product graph (reverify), articles (markdown, edit, publish), guides (embed
 * snippet, publish), environments (verify, login code, attach), settings (key
 * creation, snippets), the new-demo form, first-run onboarding, and the
 * API-down state on every route.
 *
 * Emits PNGs into ./artifacts.
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

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const now = Date.now();
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
const HOUR = 3_600_000;
const DAY = 86_400_000;

const SHOT =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="80"><rect width="128" height="80" fill="#14171c"/><rect x="10" y="12" width="70" height="6" rx="3" fill="#2b323b"/><rect x="10" y="26" width="108" height="40" rx="6" fill="#1a2027" stroke="#2b323b"/><rect x="18" y="34" width="34" height="5" rx="2.5" fill="#5b8cff"/></svg>'
  );

const state = {
  answered: null,
  demoBodies: [],
  articlePatches: [],
  articlePublishes: [],
  keyCreates: [],
  flowVerified: false,
  envCreates: [],
  guidePublishes: []
};

const demos = [
  {
    id: 'dem_complete',
    workspace_id: 'ws_1',
    environment_id: 'env_northwind',
    instruction: 'Create a project, then invite a teammate.',
    target_type: 'url',
    target_url: 'http://127.0.0.1:4402/app',
    status: 'complete',
    progress: 100,
    video_path: 'videos/dem_complete.mp4',
    poster_path: 'posters/dem_complete.png',
    srt_path: 'exports/dem_complete.srt',
    duration_ms: 48_000,
    outcome_json: JSON.stringify({
      goalMet: true,
      stepsCompleted: 6,
      whatWasShown: ['Projects list', 'New project form', 'Project created', 'Team page and invite form']
    }),
    failure_json: null,
    question_json: null,
    options_json: JSON.stringify({ language: 'en', fps: 30, maxSteps: 40, watermark: true, zoom: 1.6 }),
    created_at: iso(-10 * 60_000),
    started_at: iso(-9 * 60_000),
    finished_at: iso(-7 * 60_000),
    credits_used: 48
  },
  {
    id: 'dem_running',
    workspace_id: 'ws_1',
    environment_id: 'env_northwind',
    instruction: 'Walk through upgrading to the Team plan from billing.',
    target_type: 'url',
    target_url: 'http://127.0.0.1:4402/app/billing',
    status: 'running',
    progress: 42,
    video_path: null,
    poster_path: null,
    srt_path: null,
    duration_ms: null,
    outcome_json: null,
    failure_json: null,
    question_json: JSON.stringify({
      id: 'q_1',
      prompt: 'Two buttons are labelled “Continue”. Which one should the demo use?',
      options: [
        { id: 'opt_primary', label: 'The primary Continue' },
        { id: 'opt_secondary', label: 'The secondary Continue' }
      ]
    }),
    options_json: JSON.stringify({ language: 'en', fps: 30, maxSteps: 40, watermark: true, zoom: 1.6 }),
    created_at: iso(-2 * 60_000),
    started_at: iso(-90_000),
    finished_at: null,
    credits_used: 0
  },
  {
    id: 'dem_failed',
    workspace_id: 'ws_1',
    environment_id: null,
    instruction: 'Show the audit log and export it as CSV.',
    target_type: 'url',
    target_url: 'http://127.0.0.1:4402/app/audit',
    status: 'failed',
    progress: 38,
    video_path: null,
    poster_path: null,
    srt_path: null,
    duration_ms: null,
    outcome_json: null,
    failure_json: JSON.stringify({
      code: 'TARGET_UNREACHABLE',
      message: 'Chromium could not load http://127.0.0.1:4402/app/audit: connection refused.',
      remediation: {
        action: 'use_tunnel',
        hint: 'Expose the local app with a public HTTPS tunnel and pass that URL as the target.'
      }
    }),
    question_json: null,
    options_json: JSON.stringify({ language: 'en', fps: 30, maxSteps: 40, watermark: true, zoom: 1.6 }),
    created_at: iso(-3 * HOUR),
    started_at: iso(-3 * HOUR + 4000),
    finished_at: iso(-3 * HOUR + 40_000),
    credits_used: 0
  }
];

const stepSeed = [
  { idx: 0, kind: 'goto', narration: 'Open the projects page.', selector: null, role: null, name: null },
  { idx: 1, kind: 'click', narration: 'Click New project to open the form.', selector: '[data-testid="new-project"]', role: 'link', name: 'New project' },
  { idx: 2, kind: 'type', narration: 'Type the project name.', selector: '[data-testid="project-name"]', role: 'textbox', name: 'Project name' },
  { idx: 3, kind: 'click', narration: 'Create the project.', selector: '[data-testid="create-project"]', role: 'button', name: 'Create project' },
  { idx: 4, kind: 'goto', narration: 'Open the team page.', selector: null, role: null, name: null },
  { idx: 5, kind: 'click', narration: 'Send the invitation.', selector: '[data-testid="invite-submit"]', role: 'button', name: 'Invite teammate' }
];

const stepRows = stepSeed.map((step, index) => ({
  demo_id: 'dem_complete',
  idx: step.idx,
  kind: step.kind,
  narration: step.narration,
  started_at_ms: index * 4200,
  ended_at_ms: index * 4200 + 2600,
  selector: step.selector,
  role: step.role,
  name: step.name,
  box_json: JSON.stringify({ x: 120, y: 240, width: 180, height: 40 }),
  url: 'http://127.0.0.1:4402/app',
  screenshot_path: `screenshots/dem_complete/${step.idx}.png`,
  screenshotUrl: SHOT
}));

function demoDetail(row) {
  return {
    ...row,
    videoUrl: row.status === 'complete' ? '/media/demo.mp4' : null,
    posterUrl: null,
    transcriptUrl: row.status === 'complete' ? '/api/demos/dem_complete/transcript' : null,
    outcome: row.outcome_json ? JSON.parse(row.outcome_json) : null,
    failure: row.failure_json ? JSON.parse(row.failure_json) : null,
    question: row.question_json ? JSON.parse(row.question_json) : null,
    steps: row.status === 'complete' ? stepRows : stepRows.slice(0, 3).map((step) => ({ ...step, demo_id: row.id })),
    pollAfterSeconds: 3
  };
}

const environments = [
  {
    id: 'env_northwind',
    workspace_id: 'ws_1',
    name: 'Northwind',
    base_url: 'http://127.0.0.1:4402',
    sign_in_mode: 'session',
    hasSession: true,
    hasCredentials: false,
    created_at: iso(-3 * DAY),
    updated_at: iso(-HOUR)
  },
  {
    id: 'env_docs',
    workspace_id: 'ws_1',
    name: 'Docs site',
    base_url: 'https://docs.example.com',
    sign_in_mode: 'none',
    hasSession: false,
    hasCredentials: false,
    created_at: iso(-8 * DAY),
    updated_at: iso(-2 * DAY)
  }
];

const flowSteps = [
  { flow_id: 'flw_create_invite', idx: 0, kind: 'goto', selector: null, role: null, name: null, url: '/app', label: 'Open the page' },
  { flow_id: 'flw_create_invite', idx: 1, kind: 'click', selector: '[data-testid="new-project"]', role: 'link', name: 'New project', url: '/app', label: 'New project' },
  { flow_id: 'flw_create_invite', idx: 2, kind: 'type', selector: '[data-testid="project-name"]', role: 'textbox', name: 'Project name', url: '/app/projects/new', label: 'Project name' },
  { flow_id: 'flw_create_invite', idx: 3, kind: 'click', selector: '[data-testid="create-project"]', role: 'button', name: 'Create project', url: '/app/projects/new', label: 'Create project' },
  { flow_id: 'flw_create_invite', idx: 4, kind: 'goto', selector: null, role: null, name: null, url: '/app/team', label: 'Team page' },
  { flow_id: 'flw_create_invite', idx: 5, kind: 'click', selector: '[data-testid="invite-submit"]', role: 'button', name: 'Invite teammate', url: '/app/team', label: 'Send invite' }
];

const flowStepsUpgrade = [
  { flow_id: 'flw_upgrade', idx: 0, kind: 'goto', selector: null, role: null, name: null, url: '/app/billing', label: 'Billing' },
  { flow_id: 'flw_upgrade', idx: 1, kind: 'click', selector: '[data-testid="upgrade-team"]', role: 'button', name: 'Upgrade to Team', url: '/app/billing', label: 'Upgrade to Team' },
  { flow_id: 'flw_upgrade', idx: 2, kind: 'wait', selector: null, role: null, name: null, url: '/app/billing', label: 'Wait for the toast' }
];

const flows = [
  {
    id: 'flw_create_invite',
    workspace_id: 'ws_1',
    environment_id: 'env_northwind',
    name: 'Create project, invite teammate',
    signature: 'a1b2c3d4e5f60718',
    status: 'fresh',
    stale_reason: null,
    first_seen_at: iso(-2 * DAY),
    last_verified_at: iso(-HOUR),
    stepCount: flowSteps.length,
    steps: flowSteps
  },
  {
    id: 'flw_upgrade',
    workspace_id: 'ws_1',
    environment_id: 'env_northwind',
    name: 'Upgrade to Team plan',
    signature: '99887766aabbccdd',
    status: 'stale',
    stale_reason: 'Step 1 target [data-testid="upgrade-team"] no longer resolves on /app/billing.',
    first_seen_at: iso(-6 * DAY),
    last_verified_at: iso(-5 * DAY),
    stepCount: flowStepsUpgrade.length,
    steps: flowStepsUpgrade
  }
];

let articles = [
  {
    id: 'art_help',
    workspace_id: 'ws_1',
    environment_id: 'env_northwind',
    flow_id: 'flw_create_invite',
    title: 'Create a project and invite a teammate',
    slug: 'create-a-project-and-invite-a-teammate',
    excerpt: '6 steps: create a project, then invite your first teammate.',
    body_md:
      '# Create a project\n\nHere is how to create a project in Northwind.\n\n## 1. Open the new project form\n\nClick **New project** on the projects page.\n\n![Projects page](' +
      SHOT +
      ')\n\n```js\nconst project = { name: "Q4 Launch" };\n```\n\n> Tip: keep the name short.\n\n## 2. Invite a teammate\n\nOpen **Team**, enter an email, then send the invite.',
    channel: 'help_center',
    status: 'published',
    published_url: 'https://help.example.com/create-a-project',
    created_at: iso(-2 * DAY),
    updated_at: iso(-HOUR)
  },
  {
    id: 'art_training',
    workspace_id: 'ws_1',
    environment_id: 'env_northwind',
    flow_id: 'flw_upgrade',
    title: 'How billing upgrades actually work',
    slug: 'how-billing-upgrades-actually-work',
    excerpt: 'Internal runbook for the upgrade flow.',
    body_md: '# Billing upgrades\n\nInternal notes on what the upgrade flow touches.\n\n- Entitlements\n- Invoice state\n- Seat count',
    channel: 'internal_training',
    status: 'draft',
    published_url: null,
    created_at: iso(-4 * DAY),
    updated_at: iso(-2 * DAY)
  }
];

let guides = [
  {
    id: 'gd_live',
    workspace_id: 'ws_1',
    environment_id: 'env_northwind',
    flow_id: 'flw_create_invite',
    name: 'Create your first project',
    status: 'live',
    embed_key: 'ek_live_abc123',
    steps_json: JSON.stringify([
      { idx: 0, selector: '[data-testid="new-project"]', role: 'link', name: 'New project', title: 'Open the new project form', body: 'Start by clicking New project.', url: '/app' },
      { idx: 1, selector: '[data-testid="project-name"]', role: 'textbox', name: 'Project name', title: 'Name the project', body: 'Give it a name your team will recognise.', url: '/app/projects/new' },
      { idx: 2, selector: '[data-testid="create-project"]', role: 'button', name: 'Create project', title: 'Create it', body: 'Submit the form to finish.', url: '/app/projects/new' }
    ]),
    created_at: iso(-2 * DAY),
    updated_at: iso(-HOUR)
  },
  {
    id: 'gd_draft',
    workspace_id: 'ws_1',
    environment_id: 'env_northwind',
    flow_id: 'flw_upgrade',
    name: 'Invite a teammate',
    status: 'draft',
    embed_key: 'ek_draft_def456',
    steps_json: JSON.stringify([
      { idx: 0, selector: '[data-testid="invite-email"]', role: 'textbox', name: 'Invite a teammate', title: 'Enter an email', body: 'Who should join?', url: '/app/team' },
      { idx: 1, selector: '[data-testid="invite-submit"]', role: 'button', name: 'Send invite', title: 'Send the invite', body: 'They get an email right away.', url: '/app/team' }
    ]),
    created_at: iso(-5 * DAY),
    updated_at: iso(-3 * DAY)
  }
];

const keys = [
  {
    id: 'key_dash',
    workspace_id: 'ws_1',
    name: 'Dashboard',
    prefix: 'rg_9f3c2a',
    created_at: iso(-7 * DAY),
    last_used_at: iso(-60_000),
    revoked_at: null
  },
  {
    id: 'key_ci',
    workspace_id: 'ws_1',
    name: 'CI pipeline',
    prefix: 'rg_11aa22',
    created_at: iso(-14 * DAY),
    last_used_at: iso(-3 * DAY),
    revoked_at: iso(-2 * DAY)
  }
];

// ---------------------------------------------------------------------------
// Mock API
// ---------------------------------------------------------------------------

function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
const ok = (res, data) => json(res, { message: 'OK', data });
const fail = (res, status, code, message, remediation) =>
  json(res, remediation ? { code, message, remediation } : { code, message }, status);

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1`);
  const p = url.pathname;
  const method = req.method ?? 'GET';

  // ---------------------------------------------------------------- api
  if (p.startsWith('/api/')) {
    const route = p.slice(4);

    if (route === '/health') return ok(res, { version: '0.1.0', features: ['environments', 'login-codes', 'graph', 'guides'] });
    if (route === '/workspace') return ok(res, { id: 'ws_1', name: 'Acme Studio', createdAt: iso(-30 * DAY) });

    if (route === '/demos' && method === 'GET') return ok(res, demos);
    if (route === '/demos' && method === 'POST') {
      const body = await readBody(req);
      state.demoBodies.push(body);
      demos.unshift({
        id: 'dem_new',
        workspace_id: 'ws_1',
        environment_id: body.environmentId ?? null,
        instruction: body.instruction ?? '(none)',
        target_type: body.target?.type ?? 'url',
        target_url: body.target?.url ?? 'http://127.0.0.1:4402/app',
        status: 'running',
        progress: 12,
        video_path: null,
        poster_path: null,
        srt_path: null,
        duration_ms: null,
        outcome_json: null,
        failure_json: null,
        question_json: null,
        options_json: JSON.stringify(body.options ?? {}),
        created_at: iso(0),
        started_at: iso(0),
        finished_at: null,
        credits_used: 0
      });
      return ok(res, { id: 'dem_new', status: 'queued', pollAfterSeconds: 3 });
    }

    const answer = /^\/demos\/([^/]+)\/question\/answer$/.exec(route);
    if (answer && method === 'POST') {
      const body = await readBody(req);
      state.answered = { id: answer[1], body };
      const row = demos.find((demo) => demo.id === answer[1]);
      if (row) row.question_json = null;
      return ok(res, { ok: true });
    }

    const transcript = /^\/demos\/([^/]+)\/transcript$/.exec(route);
    if (transcript) {
      return ok(res, {
        demoId: transcript[1],
        lines: stepSeed.map((step, index) => ({
          stepIndex: step.idx,
          text: step.narration,
          startMs: 800 + index * 4200,
          durationMs: 2400
        }))
      });
    }

    const cancel = /^\/demos\/([^/]+)\/cancel$/.exec(route);
    if (cancel) return ok(res, { id: cancel[1], status: 'cancelled' });

    const demo = /^\/demos\/([^/]+)$/.exec(route);
    if (demo && method === 'GET') {
      const row = demos.find((item) => item.id === demo[1]);
      if (!row) return fail(res, 404, 'NOT_FOUND', `No demo ${demo[1]}`);
      return ok(res, demoDetail(row));
    }

    if (route === '/environments' && method === 'GET') return ok(res, environments);
    if (route === '/environments' && method === 'POST') {
      const body = await readBody(req);
      state.envCreates.push(body);
      const row = {
        id: 'env_new',
        workspace_id: 'ws_1',
        name: body.name,
        base_url: body.baseUrl,
        sign_in_mode: body.signInMode,
        hasSession: false,
        hasCredentials: Boolean(body.credentials),
        created_at: iso(0),
        updated_at: iso(0)
      };
      environments.push(row);
      return ok(res, row);
    }
    if (/^\/environments\/[^/]+\/verify$/.test(route) && method === 'POST') {
      return ok(res, { ok: true, signInMode: 'session', checkedAt: iso(0) });
    }
    if (/^\/environments\/[^/]+\/login-code$/.test(route) && method === 'POST') {
      return ok(res, { code: 'DIR-A1B2-C3D4-E5F6', expiresAt: iso(30 * 60_000) });
    }
    if (/^\/environments\/[^/]+\/session$/.test(route) && method === 'POST') {
      return ok(res, { ok: true, signInMode: 'session', capturedAt: iso(0), cookies: 3, origins: 1 });
    }

    const flowDetail = /^\/environments\/([^/]+)\/graph\/flows\/([^/]+)$/.exec(route);
    if (flowDetail && method === 'GET') {
      const flow = flows.find((item) => item.id === flowDetail[2]);
      return ok(res, { flow, steps: flow?.steps ?? [], screens: [], articles: [] });
    }
    const reverify = /^\/environments\/([^/]+)\/graph\/flows\/([^/]+)\/reverify$/.exec(route);
    if (reverify && method === 'POST') {
      state.flowVerified = true;
      return ok(res, {
        status: 'stale',
        staleSteps: [
          { idx: 1, selector: '[data-testid="upgrade-team"]', reason: 'not found on /app/billing; the CTA moved into a modal' }
        ],
        checkedAt: iso(0)
      });
    }
    const flowList = /^\/environments\/([^/]+)\/graph\/flows$/.exec(route);
    if (flowList) return ok(res, flows);

    if (route === '/articles' && method === 'GET') return ok(res, articles);
    if (route === '/articles/from-flow' && method === 'POST') {
      const body = await readBody(req);
      const article = {
        ...articles[0],
        id: 'art_new',
        title: 'Generated from flow',
        channel: body.channel ?? 'help_center',
        status: 'draft',
        published_url: null,
        created_at: iso(0),
        updated_at: iso(0)
      };
      articles.unshift(article);
      return ok(res, article);
    }
    const article = /^\/articles\/([^/]+)$/.exec(route);
    if (article && method === 'GET') {
      const row = articles.find((item) => item.id === article[1]);
      return row ? ok(res, row) : fail(res, 404, 'NOT_FOUND', 'No article');
    }
    if (article && method === 'PATCH') {
      const body = await readBody(req);
      state.articlePatches.push({ id: article[1], body });
      const row = articles.find((item) => item.id === article[1]);
      if (!row) return fail(res, 404, 'NOT_FOUND', 'No article');
      Object.assign(row, body, { updated_at: iso(0) });
      if (body.status) row.status = body.status;
      return ok(res, row);
    }
    const publish = /^\/articles\/([^/]+)\/(publish|unpublish)$/.exec(route);
    if (publish) {
      state.articlePublishes.push({ id: publish[1], action: publish[2] });
      const row = articles.find((item) => item.id === publish[1]);
      if (row) {
        row.status = publish[2] === 'publish' ? 'published' : 'draft';
        row.published_url = publish[2] === 'publish' ? 'https://help.example.com/generated' : null;
        row.updated_at = iso(0);
      }
      return ok(res, row);
    }

    if (route === '/guides' && method === 'GET') return ok(res, guides);
    const guidePublish = /^\/guides\/([^/]+)\/publish$/.exec(route);
    if (guidePublish && method === 'POST') {
      state.guidePublishes.push(guidePublish[1]);
      const row = guides.find((item) => item.id === guidePublish[1]);
      if (row) {
        row.status = 'live';
        row.updated_at = iso(0);
      }
      return ok(res, row);
    }
    const guide = /^\/guides\/([^/]+)$/.exec(route);
    if (guide && method === 'GET') {
      const row = guides.find((item) => item.id === guide[1]);
      return row ? ok(res, row) : fail(res, 404, 'NOT_FOUND', 'No guide');
    }
    if (guide && method === 'PATCH') {
      const body = await readBody(req);
      const row = guides.find((item) => item.id === guide[1]);
      if (row && body.status) row.status = body.status;
      return ok(res, row);
    }

    if (route === '/api-keys' && method === 'GET') return ok(res, keys);
    if (route === '/api-keys' && method === 'POST') {
      const body = await readBody(req);
      state.keyCreates.push(body);
      const plaintext = 'rg_newkey_0123456789abcdef';
      const row = {
        id: 'key_new',
        workspace_id: 'ws_1',
        name: body.name,
        prefix: plaintext.slice(0, 7),
        created_at: iso(0),
        last_used_at: null,
        revoked_at: null,
        key: plaintext,
        plaintext
      };
      keys.unshift(row);
      return ok(res, row);
    }
    const keyRevoke = /^\/api-keys\/([^/]+)$/.exec(route);
    if (keyRevoke && method === 'DELETE') {
      const row = keys.find((item) => item.id === keyRevoke[1]);
      if (row) row.revoked_at = iso(0);
      return ok(res, { id: keyRevoke[1], revokedAt: iso(0) });
    }

    if (route === '/presets') return ok(res, []);
    if (route === '/presets/voices') return ok(res, { voices: [{ id: 'sapi', label: 'System voice', provider: 'sapi', language: 'en' }] });
    if (route === '/domains/attest' && method === 'POST') return ok(res, { id: 'dom_1', host: 'example.com' });

    return fail(res, 404, 'NOT_FOUND', `No route ${method} ${p}`);
  }

  // ------------------------------------------------------------- static
  if (p === '/app') {
    res.writeHead(302, { location: '/app/' });
    res.end();
    return;
  }
  if (p === '/app/' || (p.startsWith('/app/') && !path.extname(p))) {
    const index = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(index).pipe(res);
    return;
  }
  const rel = p.replace(/^\/app\//, '');
  const file = path.join(dist, rel);
  if (!file.startsWith(dist) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`dashboard smoke: serving ${dist}`);
console.log(`                 at ${base}/app/ with a mock API\n`);

// ---------------------------------------------------------------------------
// Browser checks
// ---------------------------------------------------------------------------

const browser = await chromium.launch();
let checks = 0;
const failures = [];
const pageErrors = [];

function pass(label) {
  checks += 1;
  console.log(`  ok  ${label}`);
}

async function check(label, fn) {
  try {
    await fn();
    pass(label);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL ${label} — ${error.message}`);
  }
}

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => {
    localStorage.setItem('reelforge.apiKey', 'rg_smoke_test_key_0123456789');
    localStorage.setItem('reelforge.onboarded', '1');
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  return page;
}

const page = await newPage();
const text = (selector) => page.locator(selector).first().textContent();

try {
  // ------------------------------------------------------------- demos list
  await page.goto(`${base}/app/`);
  await page.waitForSelector('.topbar');
  await page.waitForFunction(() => location.hash.includes('demos'), undefined, { timeout: 5000 });

  await check('shell renders: sidebar, workspace name, API online, API key chip', async () => {
    await page.getByText('Product Graph', { exact: true }).first().waitFor();
    await page.getByText('Acme Studio').first().waitFor();
    await page.getByText('API online').first().waitFor();
    await page.getByText(/rg_smok/).first().waitFor();
  });

  await check('demos table shows every demo with status pills and metadata', async () => {
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
    const body = await page.locator('tbody').innerText();
    for (const expected of ['Complete', 'Recording', 'Failed', '48', '0:48', 'Northwind']) {
      assert.ok(body.includes(expected), `row text should include ${expected}`);
    }
  });

  await page.screenshot({ path: path.join(artifacts, 'demos.png'), fullPage: false });

  await check('live polling indicator appears while a run is in flight', async () => {
    await page.getByText(/Live · 1 in flight/).first().waitFor();
  });

  // ----------------------------------------------------------- demo detail
  await page.locator('tbody tr').first().click();
  await page.waitForFunction(() => location.hash.includes('dem_complete'));

  await check('demo detail: outcome, trailer and step list', async () => {
    await page.getByRole('heading', { name: 'Create a project, then invite a teammate.' }).waitFor();
    await page.getByText('Goal met').first().waitFor();
    await page.getByText('What was shown').first().waitFor();
    const videoCount = await page.locator('video').count();
    assert.equal(videoCount, 1, 'a <video> player is rendered for a signed videoUrl');
    const thumbs = await page.locator('a.thumb img').count();
    assert.equal(thumbs, 6, 'each step renders a screenshot thumbnail');
    const narration = await page.locator('.step-narration').first().innerText();
    assert.ok(narration.includes('Open the projects page.'), 'narration is shown');
  });

  await page.screenshot({ path: path.join(artifacts, 'demo-detail.png'), fullPage: false });

  await check('transcript tab lists narration with timestamps', async () => {
    await page.getByRole('tab', { name: /Transcript/ }).click();
    await page.getByText('Click New project to open the form.').first().waitFor();
    const transcript = await page.locator('.transcript').innerText();
    assert.ok(/\d:\d\d/.test(transcript), 'timestamps render');
    assert.ok(transcript.includes('step 2'), 'step index renders');
  });

  await check('raw tab shows the API payload', async () => {
    await page.getByRole('tab', { name: 'Raw' }).click();
    await page.waitForSelector('.code-block pre');
    const raw = await text('.code-block pre');
    assert.ok(raw.includes('"id": "dem_complete"'), 'raw JSON includes the demo id');
  });

  await check('question prompt can be answered', async () => {
    await page.goto(`${base}/app/#/demos/dem_running`);
    await page.getByText('The planner needs one answer').waitFor();
    await page.getByRole('button', { name: 'The primary Continue' }).click();
    await page.waitForFunction(() => !document.body.innerText.includes('The planner needs one answer'), undefined, { timeout: 6000 });
    assert.equal(state.answered?.body?.optionId, 'opt_primary');
  });

  await check('failure panel shows code, message and remediation action', async () => {
    await page.goto(`${base}/app/#/demos/dem_failed`);
    await page.getByText('TARGET_UNREACHABLE').first().waitFor();
    const body = await page.locator('main').innerText();
    assert.ok(body.includes('Chromium could not load'), 'message renders');
    assert.ok(body.includes('use_tunnel'), 'remediation action renders');
    assert.ok(body.includes('Expose the local app'), 'remediation hint renders');
    await page.getByRole('button', { name: /Retry with the same request/ }).waitFor();
  });

  // ---------------------------------------------------------------- graph
  await page.goto(`${base}/app/#/graph`);
  await check('graph: flows list with fresh/stale badges', async () => {
    await page.getByText('Create project, invite teammate').first().waitFor();
    await page.getByText('Upgrade to Team plan').first().waitFor();
    const body = await page.locator('main').innerText();
    assert.ok(body.includes('Fresh'), 'fresh badge renders');
    assert.ok(body.includes('Stale'), 'stale badge renders');
    assert.ok(body.includes('6 steps'), 'step counts render');
  });

  await check('graph: stale reason surfaced and re-check reports stale steps', async () => {
    await page.getByText('Upgrade to Team plan').first().click();
    await page.getByText('Why this flow is stale').waitFor();
    await page.getByRole('button', { name: /Re-check flow/ }).click();
    await page.getByText(/1 step\(s\) no longer resolve/).waitFor();
    assert.equal(state.flowVerified, true, 'POST reverify called');
    const body = await page.locator('main').innerText();
    assert.ok(body.includes('the CTA moved into a modal'), 'stale reason surfaces');
  });

  await page.screenshot({ path: path.join(artifacts, 'graph.png'), fullPage: false });

  // ------------------------------------------------------------- articles
  await page.goto(`${base}/app/#/articles`);
  await check('articles: markdown preview renders headings, images and code', async () => {
    await page.getByRole('heading', { name: 'Create a project and invite a teammate' }).waitFor();
    await page.waitForSelector('.md h1');
    const md = page.locator('.md');
    assert.ok((await md.innerText()).includes('Here is how to create a project'), 'body renders');
    assert.ok((await md.locator('img').count()) === 1, 'markdown image renders');
    assert.ok((await md.locator('pre code').count()) === 1, 'fenced code renders');
    assert.ok((await md.locator('table, blockquote').count()) >= 1, 'blockquote renders');
  });

  await check('articles: inline edit saves through PATCH', async () => {
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#article-title').fill('Create a project (edited)');
    await page.getByRole('button', { name: /Save changes/ }).click();
    await page.getByText('Saved').first().waitFor();
    const patch = state.articlePatches.at(-1);
    assert.equal(patch?.body?.title, 'Create a project (edited)');
    await page.getByRole('heading', { name: 'Create a project (edited)' }).waitFor();
  });

  await check('articles: publish flips the draft', async () => {
    await page.getByText('How billing upgrades actually work').first().click();
    await page.getByRole('button', { name: /^Publish$/ }).click();
    await page.getByRole('button', { name: /Unpublish/ }).waitFor({ timeout: 5000 });
    assert.equal(state.articlePublishes.at(-1)?.action, 'publish');
  });

  // --------------------------------------------------------------- guides
  await page.goto(`${base}/app/#/guides`);
  await check('guides: embed snippet, steps and publish toggle', async () => {
    await page.getByRole('heading', { name: 'Create your first project' }).first().waitFor();
    const snippet = await page.locator('.code-block pre').first().innerText();
    assert.ok(snippet.includes('/g/guide.js'), 'snippet points at the widget bundle');
    assert.ok(snippet.includes('data-guide="ek_live_abc123"'), 'snippet carries the embed key');
    const body = await page.locator('main').innerText();
    assert.ok(body.includes('Open the new project form'), 'steps preview renders');
    assert.ok(body.includes('data-testid'), 'selectors are visible');
  });

  await check('guides: publish a draft guide', async () => {
    await page.getByText('Invite a teammate', { exact: true }).first().click();
    await page.getByRole('button', { name: /^Publish$/ }).click();
    await page.getByRole('button', { name: /Unpublish/ }).waitFor({ timeout: 5000 });
    assert.equal(state.guidePublishes.at(-1), 'gd_draft');
  });

  await page.screenshot({ path: path.join(artifacts, 'guides.png'), fullPage: false });

  // --------------------------------------------------------- environments
  await page.goto(`${base}/app/#/environments`);
  await check('environments: verify + login code + attach session', async () => {
    await page.getByRole('heading', { name: 'Northwind' }).waitFor();
    await page.getByText('Session attached').first().waitFor();
    await page.getByRole('button', { name: 'Verify' }).first().click();
    await page.getByText('Sign-in verified').waitFor();
    await page.getByRole('button', { name: 'Login code' }).first().click();
    await page.getByText('DIR-A1B2-C3D4-E5F6', { exact: true }).waitFor();
    const body = await page.locator('main').innerText();
    assert.ok(body.includes('npx reelforge session DIR-A1B2-C3D4-E5F6'), 'CLI hint renders');
    await page.getByRole('button', { name: 'Attach session' }).first().click();
    await page.waitForSelector('textarea[id^="attach-"]');
  });

  // -------------------------------------------------------------- settings
  await page.goto(`${base}/app/#/settings`);
  await check('settings: key list, create (plaintext once), snippets', async () => {
    await page.getByRole('heading', { name: 'API keys' }).waitFor();
    const body = await page.locator('main').innerText();
    assert.ok(body.includes('rg_9f3c2a'), 'prefix renders');
    assert.ok(body.includes('Revoked'), 'revoked key state renders');
    assert.ok(body.includes('/api/mcp'), 'MCP snippet renders');
    assert.ok(body.includes('npm run seed'), 'seed hint renders');
    await page.locator('#new-key-name').fill('Smoke key');
    await page.getByRole('button', { name: 'Create key' }).click();
    await page.getByText('Copy this key now').waitFor();
    const after = await page.locator('main').innerText();
    assert.ok(after.includes('rg_newkey_0123456789abcdef'), 'plaintext key shown once');
    assert.equal(state.keyCreates.at(-1)?.name, 'Smoke key');
  });

  await page.screenshot({ path: path.join(artifacts, 'settings.png'), fullPage: false });

  // -------------------------------------------------------------- new demo
  await page.goto(`${base}/app/#/demos/new`);
  await check('new demo: form submits the documented request body', async () => {
    await page.getByRole('heading', { name: 'New demo' }).waitFor();
    await page.locator('#instruction').fill('Create a project, then invite a teammate.');
    await page.locator('#target-url').fill('http://127.0.0.1:4402');
    await page.getByRole('button', { name: /Record demo/ }).click();
    await page.waitForFunction(() => location.hash.includes('dem_new'), undefined, { timeout: 5000 });
    const body = state.demoBodies.at(-1);
    assert.equal(body.instruction, 'Create a project, then invite a teammate.');
    assert.deepEqual(body.target, { type: 'url', url: 'http://127.0.0.1:4402' });
    assert.equal(body.options.fps, 30);
    assert.equal(body.options.maxSteps, 40);
    assert.equal(body.options.zoom, 1.6);
    assert.equal(body.options.watermark, true);
    await page.getByText(/Recording/).first().waitFor();
  });

  await page.screenshot({ path: path.join(artifacts, 'new-demo.png'), fullPage: false });

  // --------------------------------------------------- API-down degradation
  {
    const downPage = await newPage();
    await downPage.route('**/api/**', (route) => route.abort('failed'));
    await downPage.goto(`${base}/app/#/demos`);
    await check('API down: demos shows the network error panel, not a blank page', async () => {
      await downPage.getByText('Cannot reach the Reelforge API').first().waitFor({ timeout: 8000 });
      const body = await downPage.locator('main').innerText();
      assert.ok(body.includes('npm run api'), 'the error explains how to start the API');
      assert.ok((await downPage.locator('.sidebar .nav-item').count()) === 6, 'navigation still renders');
    });

    await check('API down: every screen renders an honest state', async () => {
      const routes = ['demos', 'demos/new', 'graph', 'articles', 'guides', 'environments', 'settings'];
      for (const route of routes) {
        await downPage.goto(`${base}/app/#/${route}`);
        await downPage.waitForTimeout(500);
        const body = (await downPage.locator('main').innerText()).trim();
        assert.ok(body.length > 40, `#/${route} rendered ${body.length} chars`);
      }
    });

    await downPage.screenshot({ path: path.join(artifacts, 'api-down.png'), fullPage: false });
    await downPage.close();
  }

  // ----------------------------------------------------------- onboarding
  {
    const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const firstRun = await fresh.newPage();
    firstRun.on('pageerror', (error) => pageErrors.push(error.message));
    await firstRun.goto(`${base}/app/`);
    await check('first run: onboarding panel with seed hint and paste field', async () => {
      await firstRun.getByText('Connect this dashboard to your API').waitFor();
      const body = await firstRun.locator('.onboard-card').innerText();
      assert.ok(body.includes('npm run seed'), 'the exact seed hint renders');
      assert.ok(body.includes('npm run api'), 'the api hint renders');
      assert.equal(await firstRun.locator('#onboard-key').count(), 1, 'paste field renders');
    });
    await firstRun.screenshot({ path: path.join(artifacts, 'onboarding.png'), fullPage: false });
    await fresh.close();
  }

  await check('no uncaught page errors', async () => {
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
  });
} finally {
  await browser.close();
  server.close();
}

console.log('');
if (failures.length > 0) {
  console.error(`dashboard smoke: ${failures.length} check(s) failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`dashboard smoke: ${checks} checks passed`);
console.log(`artifacts: ${artifacts}`);
