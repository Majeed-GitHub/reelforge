import { useCallback, useEffect, useRef, useState } from 'react';

export type LoaderState<T> = {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
};

/**
 * Minimal data-fetching hook: one request per (nonce, deps) pair, no cache, no
 * library. `loading` is derived (no data yet, no error yet) so background
 * refreshes never blank out content that is already on screen.
 */
export function useLoader<T>(load: () => Promise<T>, deps: unknown[]): LoaderState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    setError(null);
    loadRef.current().then(
      (value) => {
        if (alive) setData(value);
      },
      (cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading: data === null && error === null, reload };
}

/** Runs `fn` on an interval while `ms` is a positive number and the tab is visible. */
export function usePolling(fn: () => void, ms: number | null, enabled = true): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled || !ms || ms <= 0) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') fnRef.current();
    }, ms);
    return () => window.clearInterval(id);
  }, [ms, enabled]);
}

/** Re-renders on an interval so "3m ago" style timestamps stay honest. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export type CopyState = { copied: boolean; failed: boolean; copy: (text: string) => void };

export function useCopy(resetMs = 1600): CopyState {
  const [state, setState] = useState({ copied: false, failed: false });
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  const copy = useCallback(
    (text: string) => {
      const done = (ok: boolean) => {
        setState({ copied: ok, failed: !ok });
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setState({ copied: false, failed: false }), resetMs);
      };
      const clipboard = navigator.clipboard;
      if (clipboard && typeof clipboard.writeText === 'function') {
        clipboard.writeText(text).then(() => done(true), () => done(fallbackCopy(text)));
        return;
      }
      done(fallbackCopy(text));
    },
    [resetMs]
  );

  return { copied: state.copied, failed: state.failed, copy };
}

function fallbackCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** `window.confirm`, but typed and only used for destructive actions. */
export function confirmAction(message: string): boolean {
  try {
    return window.confirm(message);
  } catch {
    return false;
  }
}
