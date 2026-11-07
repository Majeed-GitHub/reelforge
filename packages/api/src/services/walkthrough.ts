/**
 * Clickable walkthrough generator.
 *
 * Director's own FAQ says it ships videos and articles, not interactive demos.
 * This builds that missing output from data the capture already recorded:
 * per-step screenshots, element boxes, narration and timings.
 *
 * The result is ONE self-contained HTML file — inline CSS, inline JS, and every
 * screenshot as a base64 `data:` URI. No fonts, no CDNs, no relative assets:
 * it opens from disk, from an email attachment, or from a static host, and it
 * works offline. It is deliberately dependency-free (no image libraries, no
 * ffmpeg): PNG dimensions are read from the IHDR header, and the rest is string
 * building.
 *
 * Per step:
 *   screenshot with a pulsing hotspot at the recorded element box (percentages,
 *   so the overlay stays glued to the image at any width), numbered badge,
 *   narration tooltip; missing screenshot -> text card; missing box -> the whole
 *   image is clickable.
 *
 * The generated file is recorded as a `demo_exports` row of kind `walkthrough`,
 * which is why `GET /api/demos/:id/exports` lists it next to GIF/VTT with no
 * extra route wiring. The public link is minted in routes/walkthrough.ts from
 * `signWalkthroughToken` (signing.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, PUBLIC_BASE_URL, VIEWPORT, absoluteFromData, ensureDirs, relativeToData } from '../../../core/src/config.ts';
import { getDb } from '../../../core/src/db.ts';
import { ApiError } from '../../../core/src/http.ts';
import { newId, nowIso } from '../../../core/src/ids.ts';
import type { Box, DemoRow, StepRow } from '../../../core/src/types.ts';
import { many, run } from '../dbq.ts';
import { safeJson } from '../util.ts';

/** Above this the file is unwieldy to email; we warn but still generate it. */
export const WALKTHROUGH_WARN_BYTES = 8 * 1024 * 1024;

/**
 * Same DDL as routes/exports.ts (which owns the table). Repeated here with
 * IF NOT EXISTS so generation works even if the exports route was not loaded
 * in this process (for example inside a script).
 */
const EXPORTS_DDL = `
CREATE TABLE IF NOT EXISTS demo_exports (
  id TEXT PRIMARY KEY,
  demo_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  path TEXT,
  size_bytes INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_demo_exports_demo ON demo_exports(demo_id, created_at DESC);
`;

function ensureExportsTable(): void {
  getDb().exec(EXPORTS_DDL);
}

export type WalkthroughScreenshot = {
  /** `<img src="…">` ready data URI. */
  dataUri: string;
  width: number;
  height: number;
};

export type WalkthroughStep = {
  /** 1-based position in the walkthrough. */
  position: number;
  index: number;
  kind: string;
  narration: string;
  url: string | null;
  screenshot: WalkthroughScreenshot | null;
  box: Box | null;
};

export type GeneratedWalkthrough = {
  /** demo_exports row id (`exp_…`); the public token is signing over this. */
  id: string;
  path: string;
  relPath: string;
  bytes: number;
  steps: number;
  /** True when the file exceeded WALKTHROUGH_WARN_BYTES. */
  overBudget: boolean;
};

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatDuration(durationMs: number | null | undefined): string {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return '—';
  const tenths = Math.round(durationMs / 100) / 10;
  if (tenths < 60) return `${tenths}s`;
  const whole = Math.round(tenths);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
}

/** PNG dimensions straight out of the IHDR chunk (no image library). */
function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function loadScreenshot(storedPath: string | null): WalkthroughScreenshot | null {
  if (!storedPath) return null;
  const absPath = absoluteFromData(storedPath);
  if (!absPath || !fs.existsSync(absPath)) return null;
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  if (buffer.length === 0) return null;
  const dims = pngDimensions(buffer) ?? { width: VIEWPORT.width, height: VIEWPORT.height };
  return {
    dataUri: `data:image/png;base64,${buffer.toString('base64')}`,
    width: dims.width,
    height: dims.height
  };
}

function normalizeBox(raw: Box | null): Box | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** Load + normalize the steps of a demo into walkthrough steps. */
export function collectWalkthroughSteps(demoId: string): WalkthroughStep[] {
  const rows = many<StepRow>('SELECT * FROM demo_steps WHERE demo_id = ? ORDER BY idx ASC', demoId);
  return rows.map((row, position) => ({
    position: position + 1,
    index: Number(row.idx),
    kind: String(row.kind ?? ''),
    narration: String(row.narration ?? '').trim(),
    url: row.url ?? null,
    screenshot: loadScreenshot(row.screenshot_path),
    box: normalizeBox(safeJson<Box>(row.box_json))
  }));
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** Hotspot geometry in percentages, plus which side the tooltip flips to. */
function hotspotGeometry(box: Box, screenshot: WalkthroughScreenshot): { style: string; tipClass: string } {
  const left = clamp((box.x / screenshot.width) * 100, 0, 99);
  const top = clamp((box.y / screenshot.height) * 100, 0, 99);
  const width = clamp((box.width / screenshot.width) * 100, 1, 100 - left);
  const height = clamp((box.height / screenshot.height) * 100, 1, 100 - top);
  const classes: string[] = [];
  if (top < 26) classes.push('below');
  if (left < 16) classes.push('align-left');
  else if (left + width > 84) classes.push('align-right');
  const style = `left:${left.toFixed(2)}%;top:${top.toFixed(2)}%;width:${width.toFixed(2)}%;height:${height.toFixed(2)}%`;
  return { style, tipClass: classes.join(' ') };
}

function stepMarkup(step: WalkthroughStep, total: number): string {
  const label = step.narration || `Step ${step.position}`;
  const aria = step.position === total ? `Finish walkthrough: ${label}` : `Next step: ${label}`;
  const number = String(step.position);
  const dataNarration = esc(label);

  if (!step.screenshot) {
    // Honest degradation: no screenshot for this step, so show its narration.
    return `    <section class="step" data-step="${number}" data-narration="${dataNarration}" hidden>
      <button class="textcard" type="button" data-advance aria-label="${esc(aria)}">
        <span class="badge" aria-hidden="true">${number}</span>
        <span class="textcard-copy">${esc(label)}</span>
        <span class="textcard-hint" aria-hidden="true">No screenshot for this step — click to continue</span>
      </button>
    </section>`;
  }

  const image = `<img src="${step.screenshot.dataUri}" width="${step.screenshot.width}" height="${step.screenshot.height}" alt="Step ${number} of ${total}: ${esc(label)}" decoding="async" />`;

  if (!step.box) {
    // No recorded box: the whole screenshot is the target.
    return `    <section class="step" data-step="${number}" data-narration="${dataNarration}" hidden>
      <div class="frame">
        ${image}
        <button class="hotspot whole" type="button" data-advance aria-label="${esc(aria)}">
          <span class="badge" aria-hidden="true">${number}</span>
          <span class="tip">${esc(label)}</span>
        </button>
      </div>
    </section>`;
  }

  const geometry = hotspotGeometry(step.box, step.screenshot);
  return `    <section class="step" data-step="${number}" data-narration="${dataNarration}" hidden>
      <div class="frame">
        ${image}
        <button class="hotspot" type="button" data-advance style="${geometry.style}" aria-label="${esc(aria)}">
          <span class="pulse" aria-hidden="true"></span>
          <span class="badge" aria-hidden="true">${number}</span>
          <span class="tip ${geometry.tipClass}">${esc(label)}</span>
        </button>
      </div>
    </section>`;
}

const STYLE = `
:root {
  color-scheme: dark;
  --bg: #0b1220;
  --panel: #121a2b;
  --panel-2: #172136;
  --line: #24314d;
  --text: #e8eefc;
  --muted: #93a3c4;
  --accent: #5eead4;
  --accent-2: #38bdf8;
  --ring: #38bdf8;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  min-height: 100vh;
  background:
    radial-gradient(1100px 520px at 12% -8%, rgba(56, 189, 248, 0.20), transparent 62%),
    radial-gradient(900px 460px at 92% 0%, rgba(94, 234, 212, 0.14), transparent 58%),
    var(--bg);
  color: var(--text);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.app { width: 100%; max-width: 1140px; margin: 0 auto; padding: 22px 20px 46px; }
.brand { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
.brand .dot { width: 9px; height: 9px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 0 18px rgba(94,234,212,.55); }
.stage { margin-top: 22px; }
.cover, .end {
  background: linear-gradient(180deg, var(--panel), rgba(18,26,43,.72));
  border: 1px solid var(--line);
  border-radius: 18px;
  padding: clamp(28px, 5vw, 64px);
  text-align: left;
}
.kicker { margin: 0 0 14px; color: var(--accent-2); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
.cover h1 { margin: 0 0 16px; font-size: clamp(26px, 4.2vw, 46px); line-height: 1.12; letter-spacing: -.02em; }
.meta { margin: 0 0 28px; color: var(--muted); font-size: 14px; }
.end h2 { margin: 0 0 10px; font-size: clamp(24px, 3.4vw, 36px); letter-spacing: -.015em; }
.end p { margin: 0 0 24px; color: var(--muted); }
.btn {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--text);
  border-radius: 11px;
  padding: 11px 20px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.btn:hover { border-color: var(--accent-2); }
.btn:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.btn.primary { background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #06212b; border-color: transparent; }
.btn[disabled] { opacity: .45; cursor: default; }
.hint { margin: 18px 0 0; color: var(--muted); font-size: 13px; }
.hint kbd { border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; padding: 1px 6px; font: inherit; font-size: 12px; background: var(--panel-2); }
.frame { position: relative; display: block; width: 100%; margin: 0 auto; border-radius: 14px; overflow: visible; line-height: 0; }
.frame img { display: block; width: 100%; height: auto; border-radius: 14px; border: 1px solid var(--line); background: #000; }
.hotspot {
  position: absolute;
  display: block;
  padding: 0;
  border: 2px solid rgba(56, 189, 248, .95);
  border-radius: 9px;
  background: rgba(56, 189, 248, .10);
  cursor: pointer;
  min-width: 26px;
  min-height: 26px;
  line-height: 0;
}
.hotspot:hover { background: rgba(56, 189, 248, .18); }
.hotspot:focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; }
.hotspot.whole { left: 0; top: 0; width: 100%; height: 100%; border-style: dashed; border-color: rgba(56,189,248,.55); background: transparent; border-radius: 14px; }
.pulse {
  position: absolute;
  inset: -7px;
  border-radius: 13px;
  border: 2px solid var(--ring);
  pointer-events: none;
  animation: rf-pulse 1.9s cubic-bezier(.2, .6, .3, 1) infinite;
}
@keyframes rf-pulse {
  0% { transform: scale(.96); opacity: .9; }
  70% { transform: scale(1.28); opacity: 0; }
  100% { transform: scale(1.28); opacity: 0; }
}
.badge {
  position: absolute;
  top: -13px;
  left: -13px;
  min-width: 26px;
  height: 26px;
  padding: 0 7px;
  border-radius: 13px;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #06212b;
  font: 700 13px/26px ui-sans-serif, system-ui, sans-serif;
  text-align: center;
  box-shadow: 0 4px 14px -4px rgba(0,0,0,.8);
  pointer-events: none;
}
.whole .badge { top: 10px; left: 10px; }
.tip {
  position: absolute;
  z-index: 3;
  bottom: calc(100% + 14px);
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  max-width: min(360px, 62vw);
  padding: 10px 13px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: rgba(18, 26, 43, .97);
  color: var(--text);
  font: 500 13.5px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  text-align: left;
  white-space: normal;
  box-shadow: 0 18px 40px -18px rgba(0,0,0,.95);
  pointer-events: none;
}
.tip.below { bottom: auto; top: calc(100% + 14px); }
.tip.align-left { left: 0; transform: none; }
.tip.align-right { left: auto; right: 0; transform: none; }
.whole .tip { bottom: auto; top: 50px; left: 10px; transform: none; }
.textcard {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid var(--line);
  background: linear-gradient(180deg, var(--panel), rgba(18,26,43,.72));
  border-radius: 18px;
  padding: clamp(26px, 5vw, 58px);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.textcard:hover { border-color: var(--accent-2); }
.textcard:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.textcard .badge { position: static; display: inline-block; margin-bottom: 18px; }
.textcard-copy { display: block; font-size: clamp(20px, 2.8vw, 30px); line-height: 1.25; letter-spacing: -.01em; }
.textcard-hint { display: block; margin-top: 20px; color: var(--muted); font-size: 13px; }
.controls {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-top: 20px;
}
.controls .bar { flex: 1; height: 8px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--line); overflow: hidden; }
.controls .bar span { display: block; height: 100%; width: 0; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width .2s ease; }
.progress-text { min-width: 66px; color: var(--muted); font-variant-numeric: tabular-nums; font-size: 14px; text-align: center; }
.live { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); border: 0; }
footer { margin-top: 30px; color: var(--muted); font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 8px 16px; justify-content: space-between; }
.step:not([hidden]) { animation: rf-in .22s ease-out both; }
@keyframes rf-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@media (max-width: 640px) {
  .controls { flex-wrap: wrap; }
  .controls .bar { order: 3; flex-basis: 100%; }
  .tip { max-width: 76vw; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .pulse { opacity: .55; }
}
`;

/**
 * Inlined player. Kept deliberately small and dependency-free; uses only
 * string concatenation so nothing needs escaping beyond the surrounding
 * `<script>` tag.
 */
const SCRIPT = `
(function () {
  'use strict';
  var steps = Array.prototype.slice.call(document.querySelectorAll('.step'));
  var total = steps.length;
  var cover = document.getElementById('cover');
  var end = document.getElementById('end');
  var controls = document.getElementById('controls');
  var back = document.getElementById('back');
  var next = document.getElementById('next');
  var restart = document.getElementById('restart');
  var start = document.getElementById('start');
  var progressText = document.getElementById('progress-text');
  var progressBar = document.getElementById('progressbar');
  var progressFill = document.getElementById('progress-fill');
  var live = document.getElementById('live');
  var title = document.getElementById('cover-title') ? document.getElementById('cover-title').textContent : '';
  var current = 0;

  function focusElement(element) {
    if (!element) return;
    try { element.focus({ preventScroll: true }); } catch (error) { element.focus(); }
  }

  function announce(text) {
    if (live) live.textContent = text;
  }

  function render() {
    cover.hidden = current !== 0;
    end.hidden = current !== total + 1;
    controls.hidden = current === 0 || current === total + 1;
    for (var i = 0; i < steps.length; i += 1) {
      steps[i].hidden = current !== i + 1;
    }
    var shown = Math.min(Math.max(current, 1), total);
    progressText.textContent = shown + ' / ' + total;
    progressBar.setAttribute('aria-valuenow', String(shown));
    progressFill.style.width = (total ? (shown / total) * 100 : 0) + '%';
    back.disabled = current <= 1;
    next.textContent = current >= total ? 'Finish' : 'Next';
    if (current === 0) {
      announce('Walkthrough ready. ' + total + ' steps. Press Start to begin.');
      focusElement(start);
      return;
    }
    if (current === total + 1) {
      announce('Walkthrough complete. ' + total + ' of ' + total + ' steps.');
      focusElement(restart);
      return;
    }
    var section = steps[current - 1];
    var narration = section.getAttribute('data-narration') || '';
    var target = section.querySelector('.hotspot') || section.querySelector('.textcard');
    announce('Step ' + current + ' of ' + total + (narration ? '. ' + narration : ''));
    focusElement(target);
  }

  function go(to) {
    current = Math.min(Math.max(to, 0), total + 1);
    render();
  }

  start.addEventListener('click', function () { go(1); });
  restart.addEventListener('click', function () { go(1); });
  back.addEventListener('click', function () { go(current - 1); });
  next.addEventListener('click', function () { go(current >= total ? total + 1 : current + 1); });

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    var trigger = target.closest('[data-advance]');
    if (!trigger) return;
    event.preventDefault();
    go(current + 1);
  });

  document.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    var key = event.key;
    if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown') {
      event.preventDefault();
      go(current + 1);
    } else if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp') {
      event.preventDefault();
      go(current - 1);
    } else if (key === 'Escape' || key === 'Home') {
      event.preventDefault();
      go(0);
    }
  });

  render();
})();
`;

/**
 * Build the self-contained HTML document for a completed demo.
 * Pure string building (no I/O) apart from the already-embedded screenshots.
 */
export function buildWalkthroughHtml(input: {
  demo: DemoRow;
  steps: WalkthroughStep[];
  generatedAt?: string;
}): string {
  const { demo, steps } = input;
  const generatedAt = input.generatedAt ?? nowIso();
  const total = steps.length;
  const instruction = String(demo.instruction ?? '').trim() || 'Product walkthrough';
  const duration = formatDuration(demo.duration_ms);
  const recorded = formatDate(demo.finished_at ?? demo.created_at);

  const coverMeta = [
    `${total} step${total === 1 ? '' : 's'}`,
    duration === '—' ? null : duration,
    `Recorded ${recorded}`,
    'Works offline · one file'
  ]
    .filter(Boolean)
    .join(' · ');

  const stepsMarkup = steps.map((step) => stepMarkup(step, total)).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="generator" content="Reelforge walkthrough" />
<meta name="description" content="${esc(instruction)}" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" />
<title>${esc(instruction)} — Reelforge walkthrough</title>
<style>${STYLE}</style>
</head>
<body>
<div class="app">
  <div class="brand"><span class="dot" aria-hidden="true"></span> Reelforge · interactive walkthrough</div>

  <main class="stage" id="stage">
    <section class="cover" id="cover">
      <p class="kicker">Interactive walkthrough</p>
      <h1 id="cover-title">${esc(instruction)}</h1>
      <p class="meta">${esc(coverMeta)}</p>
      <button class="btn primary" id="start" type="button">Start walkthrough</button>
      <p class="hint">Use <kbd>←</kbd> <kbd>→</kbd> to move between steps, <kbd>Esc</kbd> to close. Self-contained: no network needed.</p>
    </section>

${stepsMarkup}

    <section class="end" id="end" hidden>
      <h2>Walkthrough complete</h2>
      <p>That was all ${total} step${total === 1 ? '' : 's'} of “${esc(instruction)}”.</p>
      <button class="btn primary" id="restart" type="button">Restart walkthrough</button>
    </section>
  </main>

  <div class="controls" id="controls" hidden>
    <button class="btn" id="back" type="button">Back</button>
    <span class="progress-text" id="progress-text">1 / ${total}</span>
    <div class="bar" id="progressbar" role="progressbar" aria-label="Walkthrough progress" aria-valuemin="1" aria-valuemax="${total}" aria-valuenow="1"><span id="progress-fill"></span></div>
    <button class="btn primary" id="next" type="button">Next</button>
  </div>

  <p class="live" id="live" role="status" aria-live="polite"></p>

  <footer>
    <span>Recorded with Reelforge · ${esc(PUBLIC_BASE_URL)}</span>
    <span>Generated ${esc(formatDate(generatedAt))} · v0.3</span>
  </footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/**
 * Generate + store a walkthrough for a demo and record it in `demo_exports`
 * (kind `walkthrough`) so the existing exports listing shows it.
 */
export function generateWalkthrough(demo: DemoRow): GeneratedWalkthrough {
  if (demo.status !== 'complete') {
    throw new ApiError('VALIDATION_ERROR', `Demo ${demo.id} is ${demo.status}; a walkthrough needs a finished capture.`, {
      action: 'get_demo_status',
      hint: 'Poll GET /api/demos/:id until status is "complete", then generate the walkthrough.'
    }, 409);
  }

  const steps = collectWalkthroughSteps(demo.id);
  if (steps.length === 0) {
    throw new ApiError('VALIDATION_ERROR', `Demo ${demo.id} has no recorded steps to walk through.`, {
      action: 'record_again',
      hint: 'The capture finished without steps; re-record the demo before generating a walkthrough.'
    }, 409);
  }

  const html = buildWalkthroughHtml({ demo, steps });
  const bytes = Buffer.byteLength(html, 'utf8');
  const overBudget = bytes > WALKTHROUGH_WARN_BYTES;
  if (overBudget) {
    console.warn(
      `[walkthrough] ${demo.id}: generated file is ${(bytes / (1024 * 1024)).toFixed(2)} MB ` +
        `(budget ${WALKTHROUGH_WARN_BYTES / (1024 * 1024)} MB) — screenshots dominate; it will still be stored.`
    );
  }

  ensureDirs();
  ensureExportsTable();
  const id = newId('exp');
  const outDir = path.join(PATHS.exports, demo.id);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `walkthrough-${id}.html`);
  fs.writeFileSync(outPath, html, 'utf8');
  const relPath = relativeToData(outPath) ?? outPath;
  const ts = nowIso();

  run(
    `INSERT INTO demo_exports (id, demo_id, workspace_id, kind, status, path, size_bytes, error, created_at, finished_at)
     VALUES (?, ?, ?, 'walkthrough', 'complete', ?, ?, NULL, ?, ?)`,
    id,
    demo.id,
    demo.workspace_id,
    relPath,
    bytes,
    ts,
    ts
  );

  return { id, path: outPath, relPath, bytes, steps: steps.length, overBudget };
}
