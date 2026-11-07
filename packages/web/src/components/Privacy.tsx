import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { usePrivacy } from '../privacy.ts';
import { Icon } from './icons.tsx';

const PEEK_MS = 4000;

export type PrivacyVariant = 'text' | 'block' | 'image' | 'fill';

/**
 * Wraps content that would leak product or customer information onto a shared
 * screen. The real text stays in the DOM and in the accessibility tree — it is
 * blurred, never removed — so layout cannot jump and screen readers still get
 * the content.
 *
 * Masking is visual only: one click reveals that item for PEEK_MS, then it
 * re-masks. Hover deliberately does not reveal (a shared cursor moves on the
 * audience's screen too).
 */
export function Privacy({
  label,
  children,
  variant = 'text',
  disabled = false,
  className
}: {
  label: string;
  children: ReactNode;
  variant?: PrivacyVariant;
  /** Bypass masking for this instance (e.g. a video the user chose to play). */
  disabled?: boolean;
  className?: string;
}) {
  const enabled = usePrivacy();
  const masked = enabled && !disabled;
  const [peeking, setPeeking] = useState(false);
  const timer = useRef<number | null>(null);

  function clearTimer() {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }

  // Turning privacy off (or playing a masked video) drops any peek.
  useEffect(() => {
    if (!masked) {
      clearTimer();
      setPeeking(false);
    }
  }, [masked]);

  useEffect(() => () => clearTimer(), []);

  function reveal() {
    setPeeking(true);
    clearTimer();
    timer.current = window.setTimeout(() => {
      setPeeking(false);
      timer.current = null;
    }, PEEK_MS);
  }

  const classes = [
    'privacy',
    `privacy--${variant}`,
    masked ? 'is-masked' : '',
    peeking ? 'is-peeking' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={classes}
      aria-label={masked ? `Masked: ${label}. Click to reveal for 4 seconds.` : undefined}
      title={masked ? 'Masked — click to reveal for 4 seconds' : undefined}
      onClickCapture={(event) => {
        // While masked, the first click peeks instead of following the link,
        // opening the row or playing the video underneath.
        if (!masked || peeking) return;
        event.preventDefault();
        event.stopPropagation();
        reveal();
      }}
    >
      <span className="privacy-content">{children}</span>
      {masked && variant === 'fill' ? (
        <span className="privacy-hint" aria-hidden="true">
          Peek
        </span>
      ) : null}
    </span>
  );
}

/** One-line strip shown directly under the top bar while the screen is masked. */
export function PrivacyBanner() {
  return (
    <div className="privacy-banner" role="status">
      <span className="privacy-banner-dot" aria-hidden="true" />
      <p>Privacy screen on — content is masked. Shift+P to turn off.</p>
    </div>
  );
}

/** Top-bar switch. A real button, so it is focusable and reports aria-pressed. */
export function PrivacyToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="privacy-toggle"
      aria-pressed={enabled}
      aria-label="Privacy screen"
      title="Privacy screen — masks demo content while you share your screen (Shift+P)"
      onClick={onToggle}
    >
      <Icon name={enabled ? 'eye-off' : 'eye'} size={14} />
      <span className="privacy-toggle-label">Privacy screen</span>
    </button>
  );
}
