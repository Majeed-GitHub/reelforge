/*
 * Shared timeline for the Reelforge social cuts.
 *
 * One scene engine for three canvases (story 1080x1920, square 1080x1080,
 * feed 1080x1350). The format comes from <body data-format="...">; scenes are
 * laid out by CSS and every animated property is a pure function of `t`
 * (seconds), exactly like promo.html.
 *
 *   window.__ready            fonts + layout measured
 *   window.__start()          start the real-time clock
 *   window.__seek(t)          freeze at t (also: ?t=12.0)
 */
(() => {
  'use strict';

  const FORMATS = {
    story: { w: 1080, h: 1920, safeTop: 250, safeBottom: 250, duration: 18 },
    square: { w: 1080, h: 1080, safeTop: 64, safeBottom: 64, duration: 18 },
    feed45: { w: 1080, h: 1350, safeTop: 80, safeBottom: 80, duration: 18 }
  };
  const FORMAT = document.body.dataset.format || 'story';
  const CFG = FORMATS[FORMAT] || FORMATS.story;
  const DURATION = CFG.duration;

  document.documentElement.style.setProperty('--safe-top', `${CFG.safeTop}px`);
  document.documentElement.style.setProperty('--safe-bottom', `${CFG.safeBottom}px`);

  // ---- easing (same curves as the 16:9 promo) ------------------------------
  function cubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sampleX = (u) => ((ax * u + bx) * u + cx) * u;
    const sampleY = (u) => ((ay * u + by) * u + cy) * u;
    const solve = (x) => {
      let u = x;
      for (let i = 0; i < 6; i++) {
        const err = sampleX(u) - x;
        if (Math.abs(err) < 1e-6) return u;
        const d = (3 * ax * u + 2 * bx) * u + cx;
        if (Math.abs(d) < 1e-6) break;
        u -= err / d;
      }
      let lo = 0, hi = 1;
      u = x;
      for (let i = 0; i < 24; i++) {
        const v = sampleX(u);
        if (Math.abs(v - x) < 1e-6) return u;
        if (v < x) lo = u; else hi = u;
        u = (lo + hi) / 2;
      }
      return u;
    };
    return (x) => (x <= 0 ? 0 : x >= 1 ? 1 : sampleY(solve(x)));
  }
  const ease = cubicBezier(0.16, 1, 0.3, 1);
  const smooth = cubicBezier(0.22, 1, 0.36, 1);
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const prog = (t, a, b) => clamp01((t - a) / (b - a));
  const lerp = (a, b, p) => a + (b - a) * p;

  // ---- markup --------------------------------------------------------------
  const stage = document.getElementById('stage');
  stage.innerHTML = `
    <div class="scene" id="scene-hook">
      <h1 class="hook">
        <span class="line" data-line="0">Your product demos,</span>
        <span class="line" data-line="1">written by the</span>
        <span class="line ember" data-line="2">product.</span>
      </h1>
    </div>

    <div class="scene" id="scene-inst">
      <div class="mini">01 — One sentence from you</div>
      <div class="typed" id="typed"><span id="typedText"></span><span class="caret" id="caret"></span></div>
      <div class="chip" id="chip"><span class="globe"></span><span>your-product.com</span></div>
      <div class="browser" id="browser">
        <div class="bar"><i></i><i></i><i></i><span>your-product.com/projects</span></div>
        <div class="page">
          <div class="row"></div>
          <div class="row short"></div>
          <div class="field" id="fieldTarget"></div>
          <div class="cta"></div>
        </div>
        <div id="ripple"></div>
        <div id="tapCursor"></div>
      </div>
    </div>

    <div class="scene" id="scene-out">
      <div class="mini">02 — One capture, four outputs</div>
      <div class="cards" id="cards">
        <div class="card" data-card="0"><span class="bar"></span><span class="pip"></span><span class="idx">01</span><b>Video</b><em>MP4 · captions</em></div>
        <div class="card" data-card="1"><span class="bar"></span><span class="pip"></span><span class="idx">02</span><b>Article</b><em>Markdown</em></div>
        <div class="card" data-card="2"><span class="bar"></span><span class="pip"></span><span class="idx">03</span><b>Walkthrough</b><em>real hotspots</em></div>
        <div class="card" data-card="3"><span class="bar"></span><span class="pip"></span><span class="idx">04</span><b>Guide</b><em>one embed tag</em></div>
      </div>
    </div>

    <div class="scene" id="scene-prov">
      <div class="mini">03 — Bring your own model</div>
      <h2 class="providers-head" id="providersHeadline">31 model providers</h2>
      <p class="providers-sub" id="providersSub">Bring your own key — or run fully offline.</p>
      <div class="mwrap" id="mwrap">
        <div class="mrow"><div class="mtrack" id="trackA"></div></div>
        <div class="mrow"><div class="mtrack" id="trackB"></div></div>
      </div>
    </div>

    <div class="scene" id="scene-end">
      <div class="endmark">REELFORGE</div>
      <div class="endrule" id="endrule"></div>
      <h2 class="endhead" id="endhead">Open source · MIT<br>Free forever</h2>
      <div class="endurl" id="endurl">github.com/<span class="ember">Majeed-GitHub</span>/reelforge</div>
      <div class="endbio" id="endbio"><span class="arrow">↳</span>link in bio</div>
    </div>

    <div id="brand"><i></i>REELFORGE</div>
    <div id="vignette"></div>
    <div id="grain"></div>
  `;

  const $ = (selector) => document.querySelector(selector);
  const el = {
    hook: $('#scene-hook'),
    hookLines: [...document.querySelectorAll('#scene-hook .line')],
    inst: $('#scene-inst'),
    instLabel: $('#scene-inst .mini'),
    typed: $('#typedText'),
    caret: $('#caret'),
    chip: $('#chip'),
    browser: $('#browser'),
    ripple: $('#ripple'),
    tapCursor: $('#tapCursor'),
    field: $('#fieldTarget'),
    out: $('#scene-out'),
    outLabel: $('#scene-out .mini'),
    cards: [...document.querySelectorAll('#scene-out .card')],
    prov: $('#scene-prov'),
    provLabel: $('#scene-prov .mini'),
    provHead: $('#providersHeadline'),
    provSub: $('#providersSub'),
    trackA: $('#trackA'),
    trackB: $('#trackB'),
    end: $('#scene-end'),
    endmark: $('#scene-end .endmark'),
    endrule: $('#endrule'),
    endhead: $('#endhead'),
    endurl: $('#endurl'),
    endbio: $('#endbio'),
    brand: $('#brand')
  };

  // ---- typed instruction ---------------------------------------------------
  const TYPED = 'Sign in, create a project, invite a teammate.';

  // ---- provider marquee ----------------------------------------------------
  const PROVIDERS = {
    free: ['Google Gemini', 'OpenRouter', 'Groq', 'Mistral AI', 'Cerebras', 'NVIDIA NIM', 'GitHub Models', 'Hugging Face Router', 'SambaNova', 'Alibaba DashScope'],
    paid: ['GMI Cloud', 'OpenAI', 'Anthropic', 'DeepSeek', 'xAI', 'Together AI', 'Fireworks AI', 'DeepInfra', 'Nebius AI Studio', 'Novita AI', 'Hyperbolic', 'Moonshot', 'Zhipu GLM', 'Perplexity', 'Azure OpenAI'],
    local: ['Ollama', 'LM Studio', 'llama.cpp', 'vLLM', 'LocalAI', 'Custom endpoint']
  };
  const ROWS = {
    a: { names: [...PROVIDERS.free, ...PROVIDERS.local], speed: 54, dir: -1, half: 0 },
    b: { names: PROVIDERS.paid, speed: 72, dir: 1, half: 0 }
  };
  for (const [key, row] of Object.entries(ROWS)) {
    const track = key === 'a' ? el.trackA : el.trackB;
    const nodes = [];
    for (let copy = 0; copy < 2; copy++) {
      for (const name of row.names) {
        const span = document.createElement('span');
        span.textContent = name;
        const dot = document.createElement('i');
        nodes.push(span, dot);
      }
    }
    nodes.pop();
    track.append(...nodes);
  }

  // ---- measure (fonts affect widths) --------------------------------------
  const metrics = { halfA: 0, halfB: 0 };
  function measure() {
    metrics.halfA = el.trackA.scrollWidth / 2;
    metrics.halfB = el.trackB.scrollWidth / 2;
  }

  const set = (node, opacity, transform) => {
    if (!node) return;
    node.style.opacity = String(Math.round(clamp01(opacity) * 1000) / 1000);
    if (transform != null) node.style.transform = transform;
  };

  // ---- timeline ------------------------------------------------------------
  function renderAt(tSeconds) {
    const t = Math.max(0, Math.min(DURATION, tSeconds));

    // brand watermark, inside the safe area
    set(el.brand, Math.min(prog(t, 0.5, 1.0), 1 - prog(t, 17.0, 17.4)), null);

    // ---------- 0.0–2.6 hook ----------
    el.hook.style.opacity = String(1 - prog(t, 2.3, 2.62));
    el.hookLines.forEach((line, i) => {
      const p = ease(prog(t, 0.16 + i * 0.14, 0.82 + i * 0.14));
      set(line, p, `translateY(${26 * (1 - p)}px)`);
    });

    // ---------- 2.5–6.45 instruction ----------
    el.inst.style.opacity = String(Math.min(prog(t, 2.5, 2.75), 1 - prog(t, 6.15, 6.45)));
    const pLabel = ease(prog(t, 2.65, 3.05));
    set(el.instLabel, pLabel, `translateY(${12 * (1 - pLabel)}px)`);

    const typedProgress = prog(t, 3.0, 4.35);
    const chars = Math.floor(typedProgress * TYPED.length);
    el.typed.textContent = TYPED.slice(0, chars);
    const typing = t >= 3.0 && t < 4.5;
    const caretOn = typing && Math.floor(t * 2.8) % 2 === 0;
    el.caret.style.opacity = typing ? (caretOn ? '1' : '0') : '0';

    const pChip = ease(prog(t, 4.45, 4.95));
    set(el.chip, pChip, `translateY(${18 * (1 - pChip)}px)`);

    const pBrowser = ease(prog(t, 4.2, 4.9));
    const zoom = ease(prog(t, 5.2, 6.25));
    set(el.browser, pBrowser, `translateY(${22 * (1 - pBrowser)}px) scale(${1 + 0.07 * zoom})`);

    const pRipple = prog(t, 5.0, 5.6);
    el.ripple.style.opacity = String((1 - pRipple) * 0.85);
    el.ripple.style.transform = `translate(-50%,-50%) scale(${0.4 + 2.8 * pRipple})`;
    const pTap = prog(t, 4.72, 4.92) * (1 - prog(t, 5.45, 5.7));
    const tapPulse = 1 + 0.3 * Math.max(0, 1 - Math.abs(t - 4.95) / 0.14);
    set(el.tapCursor, pTap, `translate(-50%,-50%) scale(${tapPulse})`);
    el.field.style.borderColor = `rgba(255,92,56,${0.25 + 0.65 * zoom})`;

    // ---------- 6.15–10.3 outputs ----------
    el.out.style.opacity = String(Math.min(prog(t, 6.15, 6.4), 1 - prog(t, 9.95, 10.3)));
    const pOut = ease(prog(t, 6.25, 6.65));
    set(el.outLabel, pOut, `translateY(${12 * (1 - pOut)}px)`);
    el.cards.forEach((card, i) => {
      const p = ease(prog(t, 6.45 + i * 0.24, 7.1 + i * 0.24));
      card.style.opacity = String(p);
      card.style.transform = `translateY(${30 * (1 - p)}px) scale(${0.985 + 0.015 * p})`;
      const bar = card.querySelector('.bar');
      if (bar) bar.style.width = `${Math.round(6 * p)}px`;
    });

    // ---------- 10.0–13.8 providers ----------
    el.prov.style.opacity = String(Math.min(prog(t, 10.0, 10.25), 1 - prog(t, 13.45, 13.8)));
    const pH = ease(prog(t, 10.2, 10.85));
    set(el.provLabel, ease(prog(t, 10.12, 10.45)), '');
    set(el.provHead, pH, `translateY(${18 * (1 - pH)}px)`);
    const pS = ease(prog(t, 10.45, 11.0));
    set(el.provSub, pS, `translateY(${14 * (1 - pS)}px)`);
    const marquee = (row, half, track) => {
      if (!half) return;
      const dist = Math.max(0, t - 10.15) * row.speed;
      const offset = row.dir < 0 ? -(dist % half) : -(half - (dist % half));
      track.style.transform = `translateX(${offset.toFixed(2)}px)`;
    };
    marquee(ROWS.a, metrics.halfA, el.trackA);
    marquee(ROWS.b, metrics.halfB, el.trackB);

    // ---------- 13.5–18 end card ----------
    el.end.style.opacity = String(Math.min(prog(t, 13.5, 13.8), 1 - prog(t, 17.25, 18)));
    const pMark = ease(prog(t, 13.65, 14.1));
    set(el.endmark, pMark, `translateY(${12 * (1 - pMark)}px)`);
    const pRule = ease(prog(t, 13.9, 14.5));
    el.endrule.style.width = `${Math.round(360 * pRule)}px`;
    el.endrule.style.opacity = String(0.9 * pRule);
    const pHead = ease(prog(t, 14.05, 14.65));
    set(el.endhead, pHead, `translateY(${18 * (1 - pHead)}px)`);
    const pUrl = ease(prog(t, 14.3, 14.9));
    set(el.endurl, pUrl, `translateY(${12 * (1 - pUrl)}px)`);
    const pBio = ease(prog(t, 14.6, 15.1));
    set(el.endbio, pBio, `translateY(${10 * (1 - pBio)}px)`);

    document.body.dataset.t = t.toFixed(3);
  }

  // ---- boot ----------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const seekRaw = params.get('t');

  function finishBoot() {
    measure();
    if (seekRaw !== null) {
      const t = Number(seekRaw);
      renderAt(Number.isFinite(t) ? t : 0);
    } else {
      renderAt(0);
    }
    window.__ready = true;
    window.__seek = (value) => renderAt(Number(value));
    window.__start = () => {
      const startedAt = performance.now();
      const tick = () => {
        const t = (performance.now() - startedAt) / 1000;
        renderAt(t);
        if (t < DURATION) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
  }

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(finishBoot).catch(finishBoot);
  } else {
    finishBoot();
  }

  window.__promo = {
    format: FORMAT,
    width: CFG.w,
    height: CFG.h,
    duration: DURATION,
    safeTop: CFG.safeTop,
    safeBottom: CFG.safeBottom,
    repo: 'github.com/Majeed-GitHub/reelforge'
  };
})();
