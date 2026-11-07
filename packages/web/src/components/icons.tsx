import type { ReactNode } from 'react';

/**
 * Hand-rolled 24px stroke icon set — one visual language (1.6px, round joins),
 * no icon package, no emoji. Every icon is decorative by default: the adjacent
 * text is the accessible label, so `aria-hidden` is always set.
 */
export type IconName =
  | 'demos'
  | 'graph'
  | 'articles'
  | 'guides'
  | 'environments'
  | 'settings'
  | 'plus'
  | 'refresh'
  | 'copy'
  | 'check'
  | 'close'
  | 'chevron-right'
  | 'chevron-down'
  | 'arrow-left'
  | 'external'
  | 'warning'
  | 'clock'
  | 'key'
  | 'terminal'
  | 'film'
  | 'link'
  | 'spark'
  | 'info'
  | 'trash'
  | 'play'
  | 'upload';

const PATHS: Record<IconName, ReactNode> = {
  demos: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="M10 9.4 14.6 12 10 14.6z" />
    </>
  ),
  graph: (
    <>
      <circle cx="6.2" cy="6.2" r="2.5" />
      <circle cx="18" cy="8.4" r="2.5" />
      <circle cx="10.8" cy="18" r="2.5" />
      <path d="M8.5 6.6l7.1 1.3M7.4 8.4l2.6 7.3M16.6 10.6l-4 5.2" />
    </>
  ),
  articles: (
    <>
      <path d="M6 3.6h7.4L18 8.2v12.2H6z" />
      <path d="M13.4 3.6v4.6H18" />
      <path d="M9 12.4h6M9 15.8h6" />
    </>
  ),
  guides: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="m14.9 9.1-1.7 4.1-4.1 1.7 1.7-4.1z" />
    </>
  ),
  environments: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M3.6 12h16.8" />
      <path d="M12 3.4c2.6 2.3 4 5.3 4 8.6s-1.4 6.3-4 8.6c-2.6-2.3-4-5.3-4-8.6s1.4-6.3 4-8.6z" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h8M16 7h4M4 12h3M11 12h9M4 17h7M15 17h5" />
      <circle cx="14" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="13" cy="17" r="2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4.5V10h-5.5" />
    </>
  ),
  copy: (
    <>
      <rect x="8.8" y="8.8" width="11" height="11" rx="2.2" />
      <path d="M15.2 5.4A1.6 1.6 0 0 0 13.6 3.8H5.6A1.8 1.8 0 0 0 3.8 5.6v8a1.6 1.6 0 0 0 1.6 1.6" />
    </>
  ),
  check: <path d="m4.8 12.6 4.9 4.9L19.2 6.6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  'chevron-right': <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  'chevron-down': <path d="m5.5 9 6.5 6.5L18.5 9" />,
  'arrow-left': <path d="M19 12H5M11 6l-6 6 6 6" />,
  external: (
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5 11 13" />
      <path d="M18.5 14.2v4.6a1.2 1.2 0 0 1-1.2 1.2H5.7a1.2 1.2 0 0 1-1.2-1.2V7.2A1.2 1.2 0 0 1 5.7 6h4.6" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4.2 21 19.8H3z" />
      <path d="M12 9.6v4.2" />
      <path d="M12 16.9h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.4V12l3.2 2" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="3.9" />
      <path d="m10.8 12.2 7.6-7.6M16 3.8l4 4M13.6 6.2l3.8 3.8" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
      <path d="m7 9.4 2.8 2.6L7 14.6M12.6 15h4.4" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
      <path d="M7.2 4.5v15M16.8 4.5v15M3 9.2h4.2M3 14.8h4.2M16.8 9.2H21M16.8 14.8H21" />
    </>
  ),
  link: (
    <>
      <path d="M9.6 14.4 14.4 9.6" />
      <path d="M12.6 6.4l1.5-1.5a3.6 3.6 0 0 1 5.1 5.1l-1.5 1.5" />
      <path d="M11.4 17.6l-1.5 1.5a3.6 3.6 0 0 1-5.1-5.1l1.5-1.5" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3.4v3.4M12 17.2v3.4M3.4 12h3.4M17.2 12h3.4" />
      <path d="m6.4 6.4 2.3 2.3M15.3 15.3l2.3 2.3M17.6 6.4l-2.3 2.3M8.7 15.3l-2.3 2.3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11v5.2M12 8.1h.01" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9.2 7V4.8h5.6V7" />
      <path d="m6.4 7 1 12.2h9.2l1-12.2" />
    </>
  ),
  play: <path d="M8.4 5.4v13.2L19 12z" />,
  upload: (
    <>
      <path d="M12 15.8V4.6" />
      <path d="m7.4 9.2 4.6-4.6 4.6 4.6" />
      <path d="M4.6 16.2v2.4a1.2 1.2 0 0 0 1.2 1.2h12.4a1.2 1.2 0 0 0 1.2-1.2v-2.4" />
    </>
  )
};

export type IconProps = {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
};

export function Icon({ name, size = 16, className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The Reelforge mark: an R whose bowl doubles as a reel. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 20V4.6h6.4a4.4 4.4 0 0 1 0 8.8H9.4" />
        <path d="M12.6 13.2 17 20" />
      </svg>
    </span>
  );
}
