/**
 * Privacy screen — "show it to me, hide it from whoever is looking at my
 * screen".
 *
 * A tiny external store (no state library): React reads it through
 * useSyncExternalStore, and the switch is also applied as
 * `data-privacy="on"` on <html> so CSS, tests and future screens can hook the
 * state without touching React.
 *
 * Persistence is localStorage['reelforge.privacy'] = 'on' | 'off'. When the
 * stored value is absent the screen is OFF: masking is never a surprise.
 */
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'reelforge.privacy';
const ATTR = 'data-privacy';

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

let enabled = readStored();
const listeners = new Set<() => void>();

/** Mirrors the React state onto <html data-privacy> so it is observable + CSS-able. */
function applyAttribute(next: boolean): void {
  try {
    const root = document.documentElement;
    if (!root) return;
    if (next) root.setAttribute(ATTR, 'on');
    else root.removeAttribute(ATTR);
  } catch {
    /* no document (tests, SSR): state alone still works */
  }
}

export function privacyEnabled(): boolean {
  return enabled;
}

export function subscribePrivacy(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setPrivacyEnabled(next: boolean): void {
  if (enabled === next) {
    applyAttribute(next);
    return;
  }
  enabled = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
  } catch {
    /* private mode: the toggle still works for this page view */
  }
  applyAttribute(next);
  for (const listener of Array.from(listeners)) listener();
}

/** Applies the persisted value; call once when the shell mounts. */
export function initPrivacy(): void {
  applyAttribute(enabled);
}

/** React binding: re-renders the caller when the privacy screen is toggled. */
export function usePrivacy(): boolean {
  return useSyncExternalStore(subscribePrivacy, privacyEnabled, privacyEnabled);
}

// Apply the persisted state as soon as this module loads, so a reload with the
// privacy screen on never paints unmasked content for a frame.
initPrivacy();
