/**
 * Reelforge — luxury promo composition.
 *
 * A deterministic timeline: renderAt(t) paints the frame for time t, so the
 * recorder can play it in real time, and a reviewer can freeze any frame with
 * ?t=12.4 (or window.__seek(12.4)). No frameworks, no dependencies, no network.
 *
 * Sound is separate: audio/build-audio.mjs generates narration (edge-tts),
 * the sound-effect set and the ambient bed with ffmpeg, and record.mjs muxes
 * them and normalises loudness.
 */
(() => {
  'use strict';

  const DURATION = 30;
  const params = new URLSearchParams(location.search);
  const format = params.get('format') || '16x9';
  const stage = document.getElementById('stage');
  stage.dataset.format = format;

  /* ---------------------------------------------------------------- easing */
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
  const lerp = (a, b, t) => a + (b - a) * t;
  /** Progress of t through [start, end], eased. */
  const span = (t, start, end, ease = easeOutExpo) => ease(clamp01((t - start) / Math.max(0.0001, end - start)));
  const fadeWindow = (t, inStart, inEnd, outStart, outEnd) =>
    Math.min(span(t, inStart, inEnd), 1 - span(t, outStart, outEnd, easeInOutCubic));

  /* -------------------------------------------------------------- timeline */
  const acts = [...document.querySelectorAll('.act')].map((el) => ({
    el,
    in: Number(el.dataset.in),
    out: Number(el.dataset.out)
  }));

  // typed instruction
  const typeline = 'Sign in, create a project, invite a teammate.';
  const typedEl = document.getElementById('typed-text');
  const caret = document.querySelector('.caret');

  // provider lanes
  const lanes = [...document.querySelectorAll('.lane')];
  const PROVIDERS = [
    'GMI Cloud', 'OpenAI', 'Anthropic', 'Gemini', 'OpenRouter', 'Groq', 'Mistral', 'Cerebras',
    'NVIDIA NIM', 'GitHub Models', 'Hugging Face', 'SambaNova', 'DashScope', 'DeepSeek', 'xAI',
    'Together', 'Fireworks', 'DeepInfra', 'Nebius', 'Novita', 'Hyperbolic', 'Moonshot', 'Zhipu',
    'Perplexity', 'Azure', 'Ollama', 'LM Studio', 'llama.cpp', 'vLLM', 'LocalAI', 'Custom'
  ];
  lanes.forEach((lane, i) => {
    const chunk = PROVIDERS.slice((i * 9) % 31).concat(PROVIDERS.slice(0, (i * 9) % 31));
    lane.innerHTML = chunk.map((n) => `<span>${n}</span>`).join('') + chunk.map((n) => `<span>${n}</span>`).join('');
  });

  const hud = document.getElementById('hud-t');
  const hudEl = document.querySelector('.hud');

  /* ------------------------------------------------------------------- 3D */
  const browser = document.querySelector('.browser-card');
  const cursor = document.querySelector('.cursor');
  const zoomFrame = document.querySelector('.zoom-frame');
  const scene = document.querySelector('.scene-3d');
  const outputs = [...document.querySelectorAll('.out')];

  /* --------------------------------------------------------------- drawing */
  function renderAt(t) {
    const T = Math.max(0, Math.min(DURATION, t));

    // global HUD + fade to black at the very end
    if (hud) hud.textContent = `00:${String(Math.floor(T)).padStart(2, '0')}`;
    if (hudEl) hudEl.style.opacity = String(span(T, 0, 0.6) * (1 - span(T, 28.6, 29.4, easeInOutCubic)));

    for (const act of acts) {
      const visible = T >= act.in - 0.01 && T <= act.out + 0.4;
      act.el.style.opacity = visible ? String(fadeWindow(T, act.in, act.in + 0.55, act.out - 0.35, act.out)) : '0';
      act.el.style.transform = `translate3d(0, ${(1 - span(T, act.in, act.in + 0.8)) * 26}px, 0)`;
    }

    /* ---- act 1: wordmark ---- */
    const wordmark = document.querySelector('.wordmark');
    const tagline = document.querySelector('.tagline');
    const rule1 = document.querySelector('.act-mark .rule');
    if (wordmark) {
      const k = span(T, 0.35, 2.1, easeOutExpo);
      wordmark.style.letterSpacing = `${lerp(0.5, 0.16, k).toFixed(3)}em`;
      wordmark.style.textIndent = `${lerp(0.5, 0.16, k).toFixed(3)}em`;
      wordmark.style.opacity = String(span(T, 0.3, 1.1));
      wordmark.style.transform =
        `translate3d(0, ${lerp(70, 0, span(T, 0.35, 1.9))}px, ${lerp(-260, 0, span(T, 0.35, 2.2))}px) ` +
        `rotateX(${lerp(16, 0, span(T, 0.35, 2.2, easeOutExpo))}deg)`;
    }
    if (tagline) {
      tagline.style.opacity = String(span(T, 1.45, 2.35));
      tagline.style.transform = `translate3d(0, ${lerp(26, 0, span(T, 1.45, 2.45))}px, 0)`;
    }
    if (rule1) rule1.style.width = `${lerp(0, 460, span(T, 0.9, 1.9))}px`;

    /* ---- act 2: instruction ---- */
    const chip = document.querySelector('.chip-url');
    const sub2 = document.querySelector('.act-instruct .sub');
    if (chip) {
      chip.style.opacity = String(span(T, 3.45, 4.2));
      chip.style.transform = `translate3d(${lerp(90, 0, span(T, 3.45, 4.3))}px, 0, ${lerp(120, 0, span(T, 3.45, 4.3))}px)`;
    }
    if (typedEl) {
      const chars = Math.round(span(T, 4.0, 6.5, (x) => x) * typeline.length);
      typedEl.textContent = typeline.slice(0, chars);
    }
    if (caret) caret.style.opacity = T > 3.8 && T < 7.4 ? (Math.floor(T * 2) % 2 === 0 ? '1' : '0') : '0';
    if (sub2) sub2.style.opacity = String(span(T, 6.6, 7.1));

    /* ---- act 3: pipeline in 3D ---- */
    if (browser) {
      const k = span(T, 8.35, 9.6, easeOutExpo);
      const push = span(T, 9.4, 14.5, easeInOutCubic);
      browser.style.opacity = String(span(T, 8.3, 8.9));
      browser.style.transform =
        `translateZ(${lerp(-420, 0, k)}px) rotateY(${lerp(26, 0, k)}deg) rotateX(${lerp(12, -2, k)}deg) ` +
        `scale(${lerp(1, 1.14, push)})`;
    }
    if (scene) {
      scene.style.perspective = '1500px';
    }
    if (cursor) {
      const move = span(T, 9.9, 11.5, easeInOutCubic);
      const x = lerp(26, 62, move);
      const y = lerp(58, 34, move);
      cursor.style.left = `${x}%`;
      cursor.style.top = `${y}%`;
      cursor.style.opacity = String(span(T, 9.6, 10.0) * (1 - span(T, 14.2, 14.5, easeInOutCubic)));
      cursor.style.transform = `scale(${lerp(1.4, 1, span(T, 9.6, 10.2))}) rotate(-12deg)`;
      const ripple = (T - 11.65) * 2.6;
      cursor.style.setProperty('--ripple', '0');
      if (ripple > 0 && ripple < 1) {
        cursor.querySelector('::after');
        cursor.style.filter = `drop-shadow(0 0 ${lerp(0, 26, ripple)}px rgba(255,92,56,${(1 - ripple) * 0.9}))`;
      } else {
        cursor.style.filter = 'none';
      }
    }
    if (zoomFrame) {
      const k = span(T, 11.65, 12.3, easeOutExpo);
      zoomFrame.style.opacity = String(k * (1 - span(T, 14.2, 14.5, easeInOutCubic)));
      zoomFrame.style.transform = `scale(${lerp(1.6, 1, k)})`;
    }
    outputs.forEach((el, i) => {
      const start = 12.15 + i * 0.22;
      const k = span(T, start, start + 0.75, easeOutBack);
      el.style.opacity = String(span(T, start, start + 0.35) * (1 - span(T, 14.2, 14.5, easeInOutCubic)));
      el.style.transform = `translate3d(0, ${lerp(40, 0, k)}px, ${lerp(-160, 60 + i * 34, k)}px) rotateY(${lerp(-16, 0, k)}deg)`;
    });
    const captionEl = document.querySelector('.act-pipeline .caption');
    if (captionEl) {
      captionEl.style.opacity = String(span(T, 13.35, 14.0));
      captionEl.style.transform = `translate3d(0, ${lerp(18, 0, span(T, 13.35, 14.1))}px, 0)`;
    }

    /* ---- act 4: providers ---- */
    const provHead = document.querySelector('.prov-head');
    const provFoot = document.querySelector('.prov-foot');
    if (provHead) {
      provHead.style.opacity = String(span(T, 14.85, 15.7));
      provHead.style.transform = `translate3d(0, ${lerp(22, 0, span(T, 14.85, 15.8))}px, 0)`;
    }
    if (provFoot) provFoot.style.opacity = String(span(T, 17.2, 18.0));
    lanes.forEach((lane, i) => {
      const speed = Number(lane.dataset.speed || 1);
      const offset = -((T - 14.6) * speed * 90) % 2400;
      const depth = Number(lane.dataset.depth || 1);
      lane.style.transform = `translate3d(${offset}px, 0, 0) scale(${1 + depth * 0.02})`;
      lane.style.filter = depth === 1 ? 'blur(1.6px)' : depth === 3 ? 'blur(2.4px)' : 'none';
    });

    /* ---- act 5: three beats ---- */
    const beats = [...document.querySelectorAll('.beat')];
    const beatStarts = [20.25, 21.75, 23.25];
    beats.forEach((beat, i) => {
      const start = beatStarts[i];
      const k = fadeWindow(T, start, start + 0.4, start + 1.22, start + 1.5);
      beat.style.opacity = String(k);
      beat.style.transform = `translate3d(0, ${lerp(24, 0, span(T, start, start + 0.6))}px, ${lerp(-140, 0, span(T, start, start + 0.7))}px)`;
    });
    const frameMorph = document.querySelector('.frame-morph');
    if (frameMorph) {
      const k = span(T, 20.6, 21.5, easeInOutCubic);
      const k2 = span(T, 21.0, 21.7, easeInOutCubic);
      frameMorph.style.width = `${lerp(430, 300, k)}px`;
      frameMorph.style.height = `${lerp(242, 380, k2)}px`;
    }
    const maskBar = document.querySelector('.mask-demo .mask');
    if (maskBar) maskBar.style.transform = `scaleX(${span(T, 22.25, 22.9, easeOutExpo)})`;
    const rippleEl = document.querySelector('.hs-ripple');
    if (rippleEl) {
      const k = ((T - 23.7) * 1.4) % 1;
      rippleEl.style.transform = `scale(${lerp(1, 3.4, k)})`;
      rippleEl.style.opacity = String(T > 23.6 && T < 24.5 ? (1 - k) * 0.9 : 0);
    }

    /* ---- act 6: end card ---- */
    const endMark = document.querySelector('.end-mark');
    const endRule = document.querySelector('.end-rule');
    const endLine = document.querySelector('.end-line');
    const endUrl = document.querySelector('.end-url');
    const endCmds = document.querySelector('.end-cmds');
    const endFoot = document.querySelector('.end-foot');
    if (endMark) {
      endMark.style.opacity = String(span(T, 24.8, 25.5));
      endMark.style.transform = `translate3d(0, ${lerp(24, 0, span(T, 24.8, 25.6))}px, 0)`;
    }
    if (endRule) endRule.style.width = `${lerp(0, 120, span(T, 25.4, 26.1))}px`;
    if (endLine) endLine.style.opacity = String(span(T, 25.9, 26.6));
    if (endUrl) {
      endUrl.style.opacity = String(span(T, 26.3, 27.0));
      endUrl.style.transform = `translate3d(0, ${lerp(16, 0, span(T, 26.3, 27.1))}px, 0)`;
    }
    if (endCmds) endCmds.style.opacity = String(span(T, 26.9, 27.5));
    if (endFoot) endFoot.style.opacity = String(span(T, 27.3, 28.0));
  }

  /* --------------------------------------------------------------- WebGL bg */
  const canvas = document.getElementById('bg');
  const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
  let uniforms = null;
  let startTime = performance.now();

  if (gl) {
    const vs = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
    const fs = `
      precision highp float;
      uniform vec2 u_res;
      uniform float u_time;
      uniform float u_act;   // 0..1 emphasis that shifts the palette per act
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        float a = hash(i), b = hash(i + vec2(1.0,0.0)), c = hash(i + vec2(0.0,1.0)), d = hash(i + vec2(1.0,1.0));
        vec2 u = f*f*(3.0-2.0*f);
        return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
      }
      void main(){
        vec2 uv = gl_FragCoord.xy / u_res;
        vec2 p = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0);
        float t = u_time * 0.055;

        // slow drifting folds
        float n1 = noise(p * 1.4 + vec2(t, -t * 0.7));
        float n2 = noise(p * 2.9 - vec2(t * 0.6, t * 1.1));
        float folds = smoothstep(0.25, 1.15, n1 * 0.65 + n2 * 0.45);

        // ember bloom, lower-left, breathing
        float d = length((p - vec2(-0.62, -0.46)) * vec2(0.85, 1.25));
        float bloom = exp(-d * 3.1) * (0.42 + 0.12 * sin(u_time * 0.55));

        // cool counter-light, upper-right
        float d2 = length((p - vec2(0.66, 0.5)) * vec2(1.0, 1.1));
        float cool = exp(-d2 * 3.6) * (0.16 + 0.05 * sin(u_time * 0.31 + 1.7));

        vec3 ink = vec3(0.031, 0.031, 0.039);
        vec3 ember = mix(vec3(0.30, 0.10, 0.05), vec3(0.95, 0.30, 0.14), u_act);
        vec3 steel = vec3(0.10, 0.14, 0.22);

        vec3 col = ink;
        col += ember * bloom * 0.55;
        col += steel * cool;
        col += vec3(0.045, 0.043, 0.05) * folds * (0.5 + 0.5 * u_act);

        // gentle vertical falloff
        col *= 0.72 + 0.5 * smoothstep(0.0, 1.1, 1.0 - abs(uv.y - 0.5) * 1.4);
        gl_FragColor = vec4(col, 1.0);
      }
    `;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn('shader error', gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const vsSh = compile(gl.VERTEX_SHADER, vs);
    const fsSh = compile(gl.FRAGMENT_SHADER, fs);
    if (vsSh && fsSh) {
      const prog = gl.createProgram();
      gl.attachShader(prog, vsSh);
      gl.attachShader(prog, fsSh);
      gl.linkProgram(prog);
      gl.useProgram(prog);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      uniforms = {
        res: gl.getUniformLocation(prog, 'u_res'),
        time: gl.getUniformLocation(prog, 'u_time'),
        act: gl.getUniformLocation(prog, 'u_act')
      };
    }
  }

  function drawBackground(t) {
    if (!gl || !uniforms) return;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(uniforms.res, w, h);
    gl.uniform1f(uniforms.time, t);
    // palette shifts warmer through the pipeline act, cooler at the end card
    const act = t < 8 ? 0.35 : t < 14.6 ? 0.85 : t < 20.1 ? 0.5 : t < 24.6 ? 0.7 : 0.25;
    gl.uniform1f(uniforms.act, act);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /* --------------------------------------------------------------- playback */
  let playing = false;
  let frozen = null;

  function frame() {
    if (!playing) return;
    const t = (performance.now() - startTime) / 1000;
    renderAt(t);
    drawBackground(t);
    if (t >= DURATION) {
      playing = false;
      return;
    }
    requestAnimationFrame(frame);
  }

  window.__start = () => {
    if (playing) return;
    frozen = null;
    startTime = performance.now();
    playing = true;
    requestAnimationFrame(frame);
  };
  window.__seek = (t) => {
    playing = false;
    frozen = t;
    renderAt(t);
    drawBackground(t);
  };
  window.__duration = DURATION;

  // ?t=12.4 renders a single frozen frame (used by the verification pass)
  const seek = params.get('t');
  if (seek !== null) {
    window.__seek(Number(seek));
  } else {
    // start on the first RAF after fonts settle, so the recording begins cleanly
    const begin = () => {
      renderAt(0);
      drawBackground(0);
      window.__start();
    };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => requestAnimationFrame(begin));
    else requestAnimationFrame(begin);
  }
})();
