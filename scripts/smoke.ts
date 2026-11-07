/**
 * End-to-end smoke test. Boots the demo product + the API (with its in-process
 * worker), then drives the whole product through the public REST surface:
 *
 *   record a demo -> finished MP4 -> transcript -> Product Graph flow
 *   -> help article draft -> in-app guide draft -> re-check the flow
 *
 *   npm run smoke
 *
 * Exits non-zero if any assertion fails, and prints the exact failure.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PATHS } from '../packages/core/src/config.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const API = process.env.REELFORGE_SMOKE_API ?? `http://127.0.0.1:${process.env.REELFORGE_API_PORT ?? 4400}`;
const DEMO_SITE = `http://127.0.0.1:${process.env.REELFORGE_DEMO_PORT ?? 4402}`;

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  â€” ${detail}` : ''}`);
}

const children: ReturnType<typeof spawn>[] = [];
function start(name: string, args: string[]): void {
  // process.execPath needs no shell on any platform; shell:true here would only
  // add a DEP0190 warning to stderr and make the run look like it failed.
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
  let err = '';
  child.stderr?.on('data', (b) => (err += String(b)));
  child.on('exit', (code) => {
    if (code && !stopping) console.error(`[smoke] ${name} exited ${code}\n${err.slice(-2000)}`);
  });
  children.push(child);
}

let stopping = false;
function stopAll(): void {
  stopping = true;
  for (const c of children) {
    if (!c.pid) continue;
    // Windows: kill the tree, otherwise the port stays bound after the run and
    // the next `npm run dev` / `npm run smoke` fails with EADDRINUSE.
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      continue;
    }
    try {
      c.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}
process.on('exit', stopAll);
process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});

async function waitFor(url: string, timeoutMs = 40_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function apiKey(): string {
  const file = path.join(PATHS.data, 'dev-api-key.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  if (process.env.REELFORGE_API_KEY) return process.env.REELFORGE_API_KEY;
  throw new Error('No API key. Run `npm run seed` first (writes data/dev-api-key.txt).');
}

type Json = Record<string, any>;

async function call(method: string, route: string, key: string | null, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${API}/api${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'X-API-Key': key } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function main(): Promise<void> {
  console.log('Reelforge smoke test\n');

  console.log('  booting demo product + APIâ€¦');
  start('demo-site', ['apps/demo-site/server.ts']);
  start('api', ['--env-file-if-exists=.env', 'packages/api/src/server.ts']);

  const siteUp = await waitFor(`${DEMO_SITE}/healthz`);
  const apiUp = await waitFor(`${API}/api/health`);
  check('demo product boots', siteUp, DEMO_SITE);
  check('API boots', apiUp, API);
  if (!siteUp || !apiUp) {
    finish();
    return;
  }

  const health = await call('GET', '/health', null);
  check('GET /health', health.status === 200 && !!health.json.data?.version, `version ${health.json.data?.version}`);
  const features: string[] = health.json.data?.features ?? [];
  check('health advertises features', ['graph', 'guides'].every((f) => features.includes(f)), features.join(','));

  const unauth = await call('GET', '/demos', null);
  check(
    'unauthenticated request rejected',
    unauth.status === 401 && unauth.json.code === 'UNAUTHORIZED',
    `${unauth.status} ${unauth.json.code}`
  );

  const key = apiKey();

  // The Product Graph is per-product, so save the product first â€” that's what
  // gives a finished demo somewhere to file its flow, article and guide.
  const envRes = await call('POST', '/environments', key, {
    name: 'Northwind Demo',
    baseUrl: DEMO_SITE,
    signInMode: 'none'
  });
  const environmentId: string | undefined = envRes.json.data?.id;
  check('environment saved', !!environmentId, environmentId ?? JSON.stringify(envRes.json).slice(0, 160));

  const started = await call('POST', '/demos', key, {
    target: { type: 'url', url: DEMO_SITE },
    environmentId,
    instruction:
      'Sign in, create a project called Q4 Launch, invite sam@example.com to the team, then upgrade to the Team plan.',
    authorized: true,
    options: { language: 'en', fps: 30, maxSteps: 30, scaleHeight: 720 }
  });
  const id: string | undefined = started.json.data?.id;
  check('POST /demos accepted', started.status === 201 || started.status === 200 ? !!id : false, `${started.status} ${id ?? JSON.stringify(started.json).slice(0, 200)}`);
  if (!id) {
    finish();
    return;
  }
  check('POST /demos returns a poll hint', typeof started.json.data?.pollAfterSeconds === 'number', String(started.json.data?.pollAfterSeconds));

  console.log('\n  recording (this takes 1â€“3 minutes)â€¦');
  let demo: Json = {};
  const deadline = Date.now() + 8 * 60_000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const r = await call('GET', `/demos/${id}`, key);
    demo = r.json.data ?? {};
    if (demo.status !== lastStatus) {
      lastStatus = demo.status;
      console.log(`    status: ${demo.status} (${Math.round((demo.progress ?? 0) * 100)}%)`);
    }
    if (['complete', 'failed', 'cancelled'].includes(demo.status)) break;
    await new Promise((res) => setTimeout(res, 1500));
  }
  check('demo finished', demo.status === 'complete', `${demo.status}${demo.failure ? ` â€” ${demo.failure.code}: ${demo.failure.message}` : ''}`);
  if (demo.status !== 'complete') {
    finish();
    return;
  }

  const videoUrl: string = demo.videoUrl ?? '';
  check('video URL returned', !!videoUrl, videoUrl.slice(0, 60));
  let videoBytes = 0;
  let videoType = '';
  if (videoUrl) {
    const full = videoUrl.startsWith('http') ? videoUrl : `${API}${videoUrl}`;
    const r = await fetch(full);
    const buf = Buffer.from(await r.arrayBuffer());
    videoBytes = buf.length;
    videoType = r.headers.get('content-type') ?? '';
    check('video downloads', r.ok && buf.length > 50_000, `${buf.length} bytes, ${videoType}`);
    check('video is a real mp4', buf.subarray(4, 8).toString() === 'ftyp', buf.subarray(4, 12).toString('ascii'));
  }
  check('duration is sane', (demo.durationMs ?? 0) > 3000, `${demo.durationMs} ms`);
  check('outcome carries a verdict', typeof demo.outcome?.goalMet === 'boolean', JSON.stringify(demo.outcome ?? {}).slice(0, 120));

  const transcript = await call('GET', `/demos/${id}/transcript`, key);
  const lines = transcript.json.data?.lines ?? transcript.json.data ?? [];
  check('transcript has narration', Array.isArray(lines) && lines.length > 0, `${Array.isArray(lines) ? lines.length : '?'} lines`);

  const envs = await call('GET', '/environments', key);
  const env = (envs.json.data ?? [])[0] ?? null;
  check('environment recorded', !!env, env?.id ?? 'none');

  const graph = env ? await call('GET', `/environments/${env.id}/graph/flows`, key) : { status: 0, json: {} as Json };
  const flows: Json[] = graph.json.data ?? [];
  check('Product Graph gained a flow', flows.length >= 1, `${flows.length} flow(s): ${flows.map((f) => f.name).join(', ')}`);

  if (env && flows[0]) {
    const reverify = await call('POST', `/environments/${env.id}/graph/flows/${flows[0].id}/reverify`, key);
    check('flow re-check runs', reverify.status === 200 && !!reverify.json.data?.status, String(reverify.json.data?.status));
  }

  const articles = await call('GET', '/articles', key);
  const articleList: Json[] = articles.json.data ?? [];
  check('help article drafted from the flow', articleList.length >= 1, `${articleList.length} article(s)`);
  const body = articleList[0] ? await call('GET', `/articles/${articleList[0].id}`, key) : { status: 0, json: {} as Json };
  check('article has a body', (body.json.data?.body_md ?? '').length > 80, `${(body.json.data?.body_md ?? '').length} chars`);

  const guides = await call('GET', '/guides', key);
  const guideList: Json[] = guides.json.data ?? [];
  check('in-app guide drafted', guideList.length >= 1, `${guideList.length} guide(s)`);
  if (guideList[0]?.embed_key) {
    const embed = await call('GET', `/guides/embed/${guideList[0].embed_key}`, null);
    check('guide is publicly embeddable', embed.status === 200 && (embed.json.data?.steps ?? []).length >= 1, `${(embed.json.data?.steps ?? []).length} step(s)`);
  }

  const graph2 = env ? await call('GET', `/environments/${env.id}/graph/flows`, key) : { status: 0, json: {} as Json };
  const screens = (graph2.json.data ?? []).length;
  check('graph still consistent', screens >= 1, `${screens} flow(s)`);

  console.log('\n  artifacts');
  console.log(`    demo      ${PATHS.data}/videos/${id}.mp4`);
  console.log(`    steps     ${demo.outcome?.stepsCompleted ?? '?'} recorded`);
  console.log(`    video     ${videoBytes} bytes`);
  finish();
}

function finish(): void {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  }
  stopAll();
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nsmoke test crashed: ${error instanceof Error ? error.stack : String(error)}`);
  stopAll();
  process.exit(1);
});
