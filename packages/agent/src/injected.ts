/**
 * The cursor, click ripple and focus ring that live *inside* the recorded page.
 *
 * Playwright's video has no pointer of its own, so the pointer is a DOM overlay:
 * every `page.mouse.move(x, y)` produces a real `mousemove`, which moves a fixed
 * element inside the page, which is therefore baked into the recorded pixels with
 * zero compositing (docs/ARCHITECTURE.md §5.1).
 *
 * Install it once per browser context:
 *
 *     await context.addInitScript({ content: CURSOR_INIT_SCRIPT });
 *
 * `addInitScript` re-runs on every navigation and every new document, so the
 * cursor survives full page loads. The script is guarded so a same-document
 * re-injection (or a 6-file bundle evaluating twice) stays idempotent.
 *
 * This is ON CAMERA: deliberately small, subtle, and fast. No neon.
 */

/** Plain-JS source of the init script. No imports, no TS syntax. */
export const CURSOR_INIT_SCRIPT = String.raw`(function () {
  'use strict';

  var VERSION = 1;
  var Z = 2147483647;
  var HOST_ID = '__reelforge_cursor_host';
  var STYLE_ID = '__reelforge_cursor_style';

  // Never touch documents that are not the top-level one: a nested iframe would
  // otherwise get a second, mirrored pointer (two cursors on camera).
  try {
    if (window.top !== window) return;
  } catch (err) {
    return; // cross-origin parent: treat as a sub-frame
  }
  if (window.__reelforgeCursorInstalled) {
    return;
  }
  window.__reelforgeCursorInstalled = true;

  var host = null;
  var pointer = null;
  var pressed = false;
  var lastX = null;
  var lastY = null;

  function styleText() {
    var rules = [
      '#' + HOST_ID + '{position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;' +
        'margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;' +
        'pointer-events:none!important;z-index:' + Z + '!important}',
      '#' + HOST_ID + ' .rf-pointer{position:absolute!important;left:0!important;top:0!important;' +
        'width:20px!important;height:20px!important;margin:0!important;padding:0!important;' +
        'pointer-events:none!important;opacity:0;will-change:transform;' +
        'transform:translate3d(-100px,-100px,0);' +
        'transition:transform 46ms linear,opacity 170ms ease-out;' +
        'filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.55))}',
      '#' + HOST_ID + ' .rf-pointer svg{display:block;transform-origin:2.6px 1.7px;' +
        'transition:transform 90ms ease-out}',
      '#' + HOST_ID + ' .rf-pointer.rf-down svg{transform:scale(.84)}',
      '#' + HOST_ID + ' .rf-ripple{position:absolute!important;left:0;top:0;width:44px;height:44px;' +
        'margin:0!important;padding:0!important;border-radius:50%!important;' +
        'border:2px solid rgba(91,140,255,.85)!important;background:rgba(91,140,255,.15)!important;' +
        'pointer-events:none!important;box-sizing:border-box!important;' +
        'animation:rf-ripple 520ms cubic-bezier(.22,.7,.3,1) forwards}',
      '@keyframes rf-ripple{' +
        '0%{transform:translate(-50%,-50%) scale(.3);opacity:.9}' +
        '70%{opacity:.32}' +
        '100%{transform:translate(-50%,-50%) scale(2.4);opacity:0}}',
      // Augmented focus ring: app focus styles are often invisible at 720p.
      'input:focus,textarea:focus,select:focus,[contenteditable="true"]:focus,[role="textbox"]:focus{' +
        'outline:2px solid rgba(91,140,255,.9)!important;outline-offset:2px!important;' +
        'box-shadow:0 0 0 5px rgba(91,140,255,.16)!important}'
    ];
    return rules.join('\n');
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.type = 'text/css';
    style.appendChild(document.createTextNode(styleText()));
    (document.head || document.documentElement).appendChild(style);
  }

  function buildPointer() {
    var el = document.createElement('div');
    el.className = 'rf-pointer';
    el.setAttribute('aria-hidden', 'true');
    // Classic arrow: white fill, dark hairline, soft shadow. ~20px on a 1280px frame.
    el.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M2.6 1.7 L2.6 15.1 L6.2 11.8 L8.7 17.3 L11.3 16.1 L8.8 10.7 L14 10.5 Z" ' +
      'fill="#ffffff" stroke="rgba(11,15,23,.78)" stroke-width="1.15" stroke-linejoin="round"/>' +
      '</svg>';
    return el;
  }

  function mount() {
    if (!document.documentElement) return false;
    ensureStyle();
    var existing = document.getElementById(HOST_ID);
    if (existing) {
      host = existing;
      pointer = host.querySelector('.rf-pointer');
      return true;
    }
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('data-reelforge-overlay', '1');
    pointer = buildPointer();
    host.appendChild(pointer);
    document.documentElement.appendChild(host);
    if (lastX !== null && lastY !== null) place(lastX, lastY, false);
    return true;
  }

  function place(x, y, show) {
    if (!pointer) return;
    if (show !== false) pointer.style.opacity = '1';
    // The SVG "hot spot" sits at 2.6,1.7 -> offset so the tip lands on the point.
    pointer.style.transform = 'translate3d(' + (x - 2.6) + 'px,' + (y - 1.7) + 'px,0)';
  }

  function onMove(event) {
    lastX = event.clientX;
    lastY = event.clientY;
    if (!host) mount();
    place(lastX, lastY, true);
  }

  function addRipple(x, y) {
    if (!host) return;
    var ripple = document.createElement('div');
    ripple.className = 'rf-ripple';
    ripple.setAttribute('aria-hidden', 'true');
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';
    host.appendChild(ripple);
    var drop = function () {
      if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
    };
    ripple.addEventListener('animationend', drop);
    // Belt and braces: if the animationend event is missed, still clean up.
    setTimeout(drop, 750);
  }

  function onDown(event) {
    pressed = true;
    if (pointer) pointer.classList.add('rf-down');
    if (!host) mount();
    addRipple(event.clientX, event.clientY);
    place(event.clientX, event.clientY, true);
  }

  function onUp() {
    pressed = false;
    if (pointer) pointer.classList.remove('rf-down');
  }

  // Capture phase so app handlers that stopPropagation cannot hide the cursor.
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('mouseup', onUp, true);
  document.addEventListener('mouseleave', function () { if (pointer) pointer.style.opacity = '0'; }, true);

  if (document.documentElement) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      if (!mount()) setTimeout(mount, 0);
    }, { once: true });
  }

  // Tiny debug surface for tests; not used by the runner.
  window.__reelforgeCursor = {
    version: VERSION,
    isMounted: function () { return Boolean(host && host.isConnected); },
    pointerAt: function () { return lastX === null ? null : { x: lastX, y: lastY }; },
    pressed: function () { return pressed; }
  };
})();`;

/** Alias used by some call sites; the value is the same init script. */
export const INIT_SCRIPT = CURSOR_INIT_SCRIPT;
