/**
 * Reelforge in-app guide widget.
 *
 * Drop this on any page:
 *   <script src="https://your-reelforge/g/guide.js" data-guide="embed_key" async></script>
 *
 * It fetches the guide, then walks the visitor through it: a dimmed page with a
 * spotlight cut-out around the real target, a tooltip with title/body, Back
 * /Next/Skip, progress dots, arrow-key + Esc handling, and a per-guide
 * "don't show again".
 *
 * Hard requirements this file is written against:
 *  - zero dependencies, one IIFE, < 6 KB gzipped;
 *  - renders inside a shadow root so it can never restyle the host page;
 *  - works inside a third-party app: no globals, no navigation, no scroll lock;
 *  - a step whose target cannot be resolved is SKIPPED and reported, never a
 *    blocker;
 *  - everything is wrapped in try/catch — the widget may never break the page
 *    it is embedded in.
 */

type GuideStep = {
  idx: number;
  selector?: string | null;
  role?: string | null;
  name?: string | null;
  title?: string | null;
  body?: string | null;
  url?: string | null;
};

type EmbedPayload = { id: string; name?: string; steps?: GuideStep[] };

(function () {
  'use strict';

  try {
    const w = window as unknown as { __reelforgeGuideStarted?: boolean };
    if (w.__reelforgeGuideStarted) return;
    w.__reelforgeGuideStarted = true;

    const script = document.currentScript as HTMLScriptElement | null;
    const src = script && script.src ? script.src : '';
    let apiOrigin = location.origin;
    try {
      if (src) apiOrigin = new URL(src).origin;
    } catch {
      /* malformed script src: fall back to this origin */
    }

    const embedKey =
      (script && (script.getAttribute('data-guide') || script.getAttribute('data-guide-key'))) ||
      new URLSearchParams(location.search).get('guide') ||
      '';
    if (!embedKey) return;

    const dismissKey = 'reelforge.guide.' + embedKey + '.dismissed';
    try {
      if (localStorage.getItem(dismissKey) === '1') return;
    } catch {
      /* storage blocked: show the guide, just cannot remember dismissal */
    }

    const STYLE = [
      ':host{all:initial}',
      '.rg{position:absolute;inset:0;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#eceef1;-webkit-font-smoothing:antialiased}',
      '.rg-hole{position:fixed;left:0;top:0;width:0;height:0;border-radius:10px;outline:2px solid #ff5c38;outline-offset:3px;box-shadow:0 0 0 9999px rgba(6,8,10,.64);transition:left .18s ease,top .18s ease,width .18s ease,height .18s ease;pointer-events:none}',
      '.rg-card{position:fixed;left:0;top:0;width:330px;max-width:calc(100vw - 24px);box-sizing:border-box;background:#101317;color:#eceef1;border:1px solid #2b323b;border-radius:12px;padding:14px 15px;box-shadow:0 26px 60px -20px rgba(0,0,0,.85);pointer-events:auto;outline:none;transition:left .15s ease,top .15s ease}',
      '.rg-top{display:flex;align-items:center;gap:8px;margin-bottom:9px}',
      '.rg-count{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8b95a3}',
      '.rg-dots{margin-left:auto;display:flex;align-items:center;gap:4px}',
      '.rg-dot{width:5px;height:5px;border-radius:50%;background:#39424d;border:0;padding:0;margin:0;cursor:pointer;transition:background .12s ease}',
      '.rg-dot[aria-current="step"]{background:#ff5c38;transform:scale(1.35)}',
      '.rg-x{display:grid;place-items:center;width:22px;height:22px;margin-left:6px;border:0;border-radius:6px;background:transparent;color:#8b95a3;font-size:16px;line-height:1;cursor:pointer;padding:0}',
      '.rg-x:hover{background:#1a2027;color:#eceef1}',
      '.rg-title{margin:0 0 4px;font-size:14.5px;font-weight:650;letter-spacing:-.01em;color:#eceef1}',
      '.rg-body{margin:0;color:#a2abb7;font-size:12.5px}',
      '.rg-actions{display:flex;align-items:center;gap:6px;margin-top:13px}',
      '.rg-btn{appearance:none;height:28px;padding:0 11px;border-radius:7px;border:1px solid #2b323b;background:#1a2027;color:#eceef1;font:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:background .12s ease}',
      '.rg-btn:hover:not(:disabled){background:#232b33}',
      '.rg-btn[disabled]{opacity:.45;cursor:not-allowed}',
      '.rg-btn.next{background:#ff5c38;border-color:transparent;color:#100603}',
      '.rg-btn.next:hover{background:#ff7452}',
      '.rg-skip{margin-left:auto;background:transparent;border-color:transparent;color:#8b95a3;font-weight:500}',
      '.rg-never{display:block;margin-top:11px;padding:0;border:0;background:none;color:#6c7683;font:inherit;font-size:11px;text-decoration:underline;cursor:pointer}',
      '.rg-never:hover{color:#a2abb7}',
      'button:focus-visible,.rg-card:focus-visible{outline:2px solid #ff5c38;outline-offset:2px}',
      '@media (prefers-reduced-motion:reduce){.rg-hole,.rg-card{transition:none}}'
    ].join('');

    // ---------------------------------------------------------------- fetch
    fetch(apiOrigin + '/api/guides/embed/' + encodeURIComponent(embedKey), {
      method: 'GET',
      credentials: 'omit',
      headers: { accept: 'application/json' }
    })
      .then(function (response) {
        if (!response.ok) throw new Error('guide HTTP ' + response.status);
        return response.json();
      })
      .then(function (payload: unknown) {
        const body = (payload && (payload as { data?: unknown }).data) || payload;
        const embed = body as EmbedPayload;
        const steps: GuideStep[] = Array.isArray(embed && embed.steps) ? (embed.steps as GuideStep[]) : [];
        if (!embed || !embed.id || steps.length === 0) return;
        start(embed, steps);
      })
      .catch(function () {
        /* no guide, no API, blocked by CSP — stay invisible */
      });

    // ---------------------------------------------------------------- state
    function start(embed: EmbedPayload, steps: GuideStep[]) {
      let host: HTMLDivElement | null = null;
      let root: ShadowRoot | null = null;
      let card: HTMLDivElement | null = null;
      let hole: HTMLDivElement | null = null;
      let titleEl: HTMLHeadingElement | null = null;
      let bodyEl: HTMLParagraphElement | null = null;
      let countEl: HTMLSpanElement | null = null;
      let dotsEl: HTMLDivElement | null = null;
      let backBtn: HTMLButtonElement | null = null;
      let nextBtn: HTMLButtonElement | null = null;

      let index = 0;
      let current: HTMLElement | null = null;
      let skipped: number[] = [];
      let frame = 0;
      let previousFocus: Element | null = null;
      let finished = false;

      // -------------------------------------------------------------- resolve
      function cssEscape(value: string): string {
        try {
          const css = window.CSS as unknown as { escape?: (v: string) => string } | undefined;
          if (css && typeof css.escape === 'function') return css.escape(value);
        } catch {
          /* fall through */
        }
        return value.replace(/["\\\]\[]/g, '\\$&');
      }

      function visible(element: Element | null): element is HTMLElement {
        if (!element || element.nodeType !== 1) return false;
        const node = element as HTMLElement;
        try {
          const rect = node.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;
          const style = getComputedStyle(node);
          if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
          return true;
        } catch {
          return false;
        }
      }

      function labelOf(element: Element): string {
        const node = element as HTMLElement;
        return (
          node.getAttribute('aria-label') ||
          (node.textContent || '').trim() ||
          node.getAttribute('placeholder') ||
          node.getAttribute('title') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      }

      function rolesFor(role: string): string {
        const r = role.toLowerCase();
        if (r === 'button') return 'button,[role="button"],input[type="button"],input[type="submit"]';
        if (r === 'link') return 'a,[role="link"]';
        if (r === 'textbox' || r === 'searchbox') return 'input,textarea,[role="textbox"],[contenteditable="true"]';
        if (r === 'combobox' || r === 'listbox') return 'select,[role="combobox"],[role="listbox"]';
        if (r === 'checkbox') return 'input[type="checkbox"],[role="checkbox"]';
        if (r === 'tab') return '[role="tab"],button';
        if (r === 'menuitem') return '[role="menuitem"],a,button';
        return '[role="' + r + '"]';
      }

      /** Fallback chain, in order: data-testid, role+name, raw selector, skip. */
      function resolve(step: GuideStep): HTMLElement | null {
        const selector = step.selector || '';

        const testId = /\[data-testid\s*=\s*["']?([^"'\]]+)["']?\s*\]/.exec(selector);
        if (testId) {
          try {
            const byTestId = document.querySelector('[data-testid="' + cssEscape(testId[1]) + '"]');
            if (visible(byTestId)) return byTestId;
          } catch {
            /* bad selector from a previous product version */
          }
        }

        const wanted = (step.name || step.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (step.role && wanted) {
          try {
            const candidates = document.querySelectorAll(rolesFor(step.role));
            for (let i = 0; i < candidates.length; i++) {
              const candidate = candidates[i];
              if (!visible(candidate)) continue;
              const label = labelOf(candidate);
              if (!label) continue;
              if (label === wanted || label.indexOf(wanted) >= 0 || (wanted.length > 3 && wanted.indexOf(label) >= 0)) {
                return candidate;
              }
            }
          } catch {
            /* ignore and fall through to the raw selector */
          }
        }

        if (selector) {
          try {
            const direct = document.querySelector(selector);
            if (visible(direct)) return direct;
          } catch {
            /* ignore */
          }
        }

        return null;
      }

      // ------------------------------------------------------------------ ui
      function build() {
        host = document.createElement('div');
        host.setAttribute('data-reelforge-guide', embed.id);
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none';
        root = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = STYLE;
        root.appendChild(style);

        const overlay = document.createElement('div');
        overlay.className = 'rg';

        hole = document.createElement('div');
        hole.className = 'rg-hole';
        hole.setAttribute('aria-hidden', 'true');

        card = document.createElement('div');
        card.className = 'rg-card';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'false');
        card.setAttribute('aria-label', embed.name || 'In-app guide');
        card.tabIndex = -1;

        const top = document.createElement('div');
        top.className = 'rg-top';

        countEl = document.createElement('span');
        countEl.className = 'rg-count';

        dotsEl = document.createElement('div');
        dotsEl.className = 'rg-dots';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'rg-x';
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close guide');
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', function () {
          finish();
        });

        top.appendChild(countEl);
        top.appendChild(dotsEl);
        top.appendChild(closeBtn);

        titleEl = document.createElement('h2');
        titleEl.className = 'rg-title';

        bodyEl = document.createElement('p');
        bodyEl.className = 'rg-body';

        const actions = document.createElement('div');
        actions.className = 'rg-actions';

        backBtn = document.createElement('button');
        backBtn.className = 'rg-btn rg-back';
        backBtn.type = 'button';
        backBtn.textContent = 'Back';
        backBtn.addEventListener('click', back);

        nextBtn = document.createElement('button');
        nextBtn.className = 'rg-btn next';
        nextBtn.type = 'button';
        nextBtn.textContent = 'Next';
        nextBtn.addEventListener('click', next);

        const skipBtn = document.createElement('button');
        skipBtn.className = 'rg-btn rg-skip';
        skipBtn.type = 'button';
        skipBtn.textContent = 'Skip';
        skipBtn.addEventListener('click', function () {
          finish();
        });

        actions.appendChild(backBtn);
        actions.appendChild(nextBtn);
        actions.appendChild(skipBtn);

        const neverBtn = document.createElement('button');
        neverBtn.className = 'rg-never';
        neverBtn.type = 'button';
        neverBtn.textContent = "Don't show again";
        neverBtn.addEventListener('click', function () {
          try {
            localStorage.setItem(dismissKey, '1');
          } catch {
            /* storage blocked */
          }
          finish();
        });

        card.appendChild(top);
        card.appendChild(titleEl);
        card.appendChild(bodyEl);
        card.appendChild(actions);
        card.appendChild(neverBtn);

        overlay.appendChild(hole);
        overlay.appendChild(card);
        root.appendChild(overlay);

        document.body.appendChild(host);
      }

      // ------------------------------------------------------------- placing
      function place() {
        if (!card || !hole) return;
        const width = window.innerWidth;
        const height = window.innerHeight;
        const gap = 8;

        if (!current) {
          hole.style.left = width / 2 + 'px';
          hole.style.top = height / 2 + 'px';
          hole.style.width = '0px';
          hole.style.height = '0px';
          card.style.left = Math.max(gap, (width - card.offsetWidth) / 2) + 'px';
          card.style.top = Math.max(gap, (height - card.offsetHeight) / 2) + 'px';
          return;
        }

        patchedScroll(current);
        const rect = current.getBoundingClientRect();
        const pad = 6;
        hole.style.left = rect.left - pad + 'px';
        hole.style.top = rect.top - pad + 'px';
        hole.style.width = Math.max(4, rect.width + pad * 2) + 'px';
        hole.style.height = Math.max(4, rect.height + pad * 2) + 'px';

        const cardW = card.offsetWidth || 330;
        const cardH = card.offsetHeight || 190;
        let top = rect.bottom + 14;
        if (top + cardH > height - gap) top = rect.top - cardH - 14;
        if (top < gap) top = Math.min(Math.max(gap, rect.bottom + 14), Math.max(gap, height - cardH - gap));
        let left = rect.left + rect.width / 2 - cardW / 2;
        left = Math.max(gap, Math.min(left, width - cardW - gap));
        card.style.left = left + 'px';
        card.style.top = top + 'px';
      }

      /** Scroll the target into view when it is off-screen, without hijacking the page. */
      function patchedScroll(element: HTMLElement) {
        try {
          const rect = element.getBoundingClientRect();
          if (rect.top < 0 || rect.bottom > window.innerHeight || rect.left < 0 || rect.right > window.innerWidth) {
            element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
          }
        } catch {
          /* ignore */
        }
      }

      // -------------------------------------------------------------- render
      function paint() {
        if (!card || !titleEl || !bodyEl || !countEl || !dotsEl || !backBtn || !nextBtn) return;
        const step = steps[index];
        if (!step) return;

        countEl.textContent = index + 1 + ' / ' + steps.length;
        titleEl.textContent = step.title || 'Step ' + (index + 1);
        bodyEl.textContent = step.body || '';
        backBtn.disabled = index === 0;
        nextBtn.textContent = index === steps.length - 1 ? 'Done' : 'Next';

        while (dotsEl.firstChild) dotsEl.removeChild(dotsEl.firstChild);
        for (let i = 0; i < steps.length; i++) {
          const dot = document.createElement('button');
          dot.className = 'rg-dot';
          dot.type = 'button';
          dot.setAttribute('aria-label', 'Go to step ' + (i + 1));
          if (i === index) dot.setAttribute('aria-current', 'step');
          dot.addEventListener('click', jump.bind(null, i));
          dotsEl.appendChild(dot);
        }
      }

      function show(from: number, direction: 1 | -1) {
        for (let i = from; i >= 0 && i < steps.length; i += direction) {
          const target = resolve(steps[i]);
          if (target) {
            index = i;
            current = target;
            paint();
            place();
            try {
              card?.focus({ preventScroll: true });
            } catch {
              /* ignore */
            }
            return true;
          }
          if (skipped.indexOf(steps[i].idx) < 0) skipped.push(steps[i].idx);
        }
        return false;
      }

      function next() {
        if (finished) return;
        if (index >= steps.length - 1) {
          finish();
          return;
        }
        if (!show(index + 1, 1)) finish();
      }

      function back() {
        if (finished) return;
        if (index <= 0) return;
        show(index - 1, -1);
      }

      function jump(to: number) {
        if (finished || to === index) return;
        show(to, to > index ? 1 : -1);
      }

      // -------------------------------------------------------------- finish
      function report() {
        if (skipped.length === 0) return;
        try {
          const url = apiOrigin + '/api/guides/' + encodeURIComponent(embed.id) + '/report';
          const send = function (body: object) {
            return fetch(url, {
              method: 'POST',
              credentials: 'omit',
              keepalive: true,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body)
            });
          };
          // The API accepts {skippedStepCount, stepIndex}; older/newer builds also
          // read `skipped`. Send both, and retry with the minimal shape on a 400 so
          // telemetry still lands if a strict validator rejects the extra key.
          send({ skippedStepCount: skipped.length, stepIndex: skipped[0], skipped: skipped.slice() })
            .then(function (response) {
              if (response && response.status === 400) {
                return send({ skippedStepCount: skipped.length, stepIndex: skipped[0] }).catch(function () {
                  /* best effort */
                });
              }
              return undefined;
            })
            .catch(function () {
              /* reporting is best-effort */
            });
        } catch {
          /* ignore */
        }
      }

      function detach() {
        removeEventListener('keydown', onKey, true);
        removeEventListener('scroll', onMove, true);
        removeEventListener('resize', onMove);
        try {
          if (host && host.parentNode) host.parentNode.removeChild(host);
        } catch {
          /* ignore */
        }
        host = null;
        root = null;
        card = null;
        hole = null;
        current = null;
      }

      function finish() {
        if (finished) return;
        finished = true;
        report();
        detach();
        try {
          const focus = previousFocus as HTMLElement | null;
          if (focus && typeof focus.focus === 'function' && document.contains(focus)) focus.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
      }

      // ------------------------------------------------------------ listeners
      function onKey(event: KeyboardEvent) {
        if (finished) return;
        try {
          const key = event.key;
          if (key === 'Escape') {
            finish();
          } else if (key === 'ArrowRight') {
            event.preventDefault();
            next();
          } else if (key === 'ArrowLeft') {
            event.preventDefault();
            back();
          }
        } catch {
          /* ignore */
        }
      }

      function onMove() {
        if (frame) return;
        frame = requestAnimationFrame(function () {
          frame = 0;
          try {
            place();
          } catch {
            /* ignore */
          }
        });
      }

      // ---------------------------------------------------------------- boot
      try {
        previousFocus = document.activeElement;
        build();
        if (!show(0, 1)) {
          // Nothing on this page matches the guide: clean up and report nothing.
          finished = true;
          detach();
          return;
        }
        addEventListener('keydown', onKey, true);
        addEventListener('scroll', onMove, true);
        addEventListener('resize', onMove);
        // Layout can settle a frame later (fonts, lazy images, host animations).
        setTimeout(onMove, 250);
      } catch {
        finished = true;
        detach();
      }
    }
  } catch {
    /* The widget must never take the host page down with it. */
  }
})();
