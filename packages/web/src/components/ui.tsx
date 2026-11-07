import type { ReactNode } from 'react';
import { useId } from 'react';
import type { ArticleChannel, ArticleStatus, DemoStatus, FlowStatus } from '@core';
import { isApiError, isNetworkError } from '../api.ts';
import { href } from '../router.ts';
import { channelLabel, errorMessage } from '../format.ts';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';
import { useCopy } from '../hooks.ts';

// ---------------------------------------------------------------------------
// Status pills
// ---------------------------------------------------------------------------

type Tone = 'neutral' | 'queued' | 'running' | 'good' | 'warn' | 'draft' | 'channel';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'pill pill-neutral',
  queued: 'pill pill-queued',
  running: 'pill pill-running',
  good: 'pill pill-complete',
  warn: 'pill pill-failed',
  draft: 'pill pill-cancelled',
  channel: 'pill pill-channel'
};

export function Pill({ tone = 'neutral', dot = false, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={TONE_CLASS[tone]}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

const DEMO_STATUS_LABEL: Record<DemoStatus, string> = {
  queued: 'Queued',
  running: 'Recording',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled'
};

export function DemoStatusPill({ status }: { status: DemoStatus | string }) {
  const known = status in DEMO_STATUS_LABEL ? (status as DemoStatus) : null;
  const tone: Tone =
    status === 'queued' ? 'queued' : status === 'running' ? 'running' : status === 'complete' ? 'good' : status === 'failed' ? 'warn' : 'draft';
  return (
    <Pill tone={tone} dot={status === 'running' || status === 'queued'}>
      {known ? DEMO_STATUS_LABEL[known] : String(status || 'unknown')}
    </Pill>
  );
}

export function FlowStatusPill({ status }: { status: FlowStatus | string }) {
  const label = status === 'fresh' ? 'Fresh' : status === 'stale' ? 'Stale' : status === 'draft' ? 'Draft' : String(status || '—');
  const tone: Tone = status === 'fresh' ? 'good' : status === 'stale' ? 'warn' : 'draft';
  return <Pill tone={tone} dot={status === 'stale'}>{label}</Pill>;
}

export function ArticleStatusPill({ status }: { status: ArticleStatus | string }) {
  return <Pill tone={status === 'published' ? 'good' : 'draft'}>{status === 'published' ? 'Published' : 'Draft'}</Pill>;
}

export function ChannelPill({ channel }: { channel: ArticleChannel | string }) {
  return <Pill tone="channel">{channelLabel(channel)}</Pill>;
}

// ---------------------------------------------------------------------------
// Empty / error / loading states
// ---------------------------------------------------------------------------

export function EmptyState({
  icon = 'spark',
  title,
  body,
  action,
  secondary,
  hint
}: {
  icon?: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  secondary?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-mark">
        <Icon name={icon} size={18} />
      </span>
      <p className="empty-title">{title}</p>
      {body ? <p className="empty-body">{body}</p> : null}
      {action || secondary ? (
        <div className="row wrap" style={{ marginTop: 4, justifyContent: 'center' }}>
          {action}
          {secondary}
        </div>
      ) : null}
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

export function Banner({
  tone = 'info',
  icon,
  title,
  children,
  actions
}: {
  tone?: 'info' | 'warn' | 'error' | 'ok';
  icon?: IconName;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const iconName: IconName = icon ?? (tone === 'error' ? 'warning' : tone === 'ok' ? 'check' : tone === 'warn' ? 'warning' : 'info');
  return (
    <div className={`banner banner-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <span className="banner-icon">
        <Icon name={iconName} size={17} />
      </span>
      <div className="grow">
        {title ? <p className="banner-title">{title}</p> : null}
        {children ? <div className="banner-body">{children}</div> : null}
        {actions ? <div className="banner-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/**
 * One panel for every failure mode: the API being down, a rejected key, or a
 * documented error envelope with a remediation. Never a blank screen.
 */
export function ErrorPanel({ error, onRetry, what }: { error: unknown; onRetry?: () => void; what?: string }) {
  const network = isNetworkError(error);
  const apiError = isApiError(error) ? error : null;
  const unauthorized = apiError?.status === 401 || apiError?.code === 'UNAUTHORIZED';

  if (network) {
    return (
      <Banner
        tone="error"
        title={what ? `Could not load ${what}` : 'Cannot reach the Reelforge API'}
        actions={
          <>
            {onRetry ? (
              <button type="button" className="btn btn-sm" onClick={onRetry}>
                <Icon name="refresh" size={14} />
                Retry
              </button>
            ) : null}
          </>
        }
      >
        <p>{errorMessage(error)}</p>
        <p style={{ marginTop: 6 }}>
          Nothing is lost — the dashboard is a read-only view over the API. Start the server with{' '}
          <code>npm run api</code> in the repo root, then retry.
        </p>
      </Banner>
    );
  }

  if (unauthorized) {
    return (
      <Banner
        tone="error"
        title="Your API key was rejected"
        actions={
          <>
            <a className="btn btn-sm" href={href.settings()}>
              <Icon name="key" size={14} />
              Open Settings
            </a>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => window.location.reload()}>
              Reload
            </button>
          </>
        }
      >
        <p>{errorMessage(error)}</p>
        <p style={{ marginTop: 6 }}>
          The key is stored in this browser only. Paste a current key in Settings — the seed script prints one:{' '}
          <code>npm run seed</code>.
        </p>
      </Banner>
    );
  }

  return (
    <Banner
      tone="error"
      title={apiError?.code ? `${apiError.code}` : what ? `Could not load ${what}` : 'Something went wrong'}
      actions={
        onRetry ? (
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            <Icon name="refresh" size={14} />
            Retry
          </button>
        ) : null
      }
    >
      <p>{errorMessage(error)}</p>
      {apiError?.remediation ? (
        <div style={{ marginTop: 8 }}>
          <p style={{ fontWeight: 600, color: 'var(--text)' }}>{apiError.remediation.action}</p>
          {apiError.remediation.hint ? <p style={{ marginTop: 2 }}>{apiError.remediation.hint}</p> : null}
        </div>
      ) : null}
    </Banner>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack-sm" aria-hidden="true" style={{ padding: 16 }}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="sk sk-line" style={{ height: 34, width: `${100 - index * 4}%` }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy + code
// ---------------------------------------------------------------------------

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const { copied, failed, copy } = useCopy();
  return (
    <button
      type="button"
      className={`btn btn-sm btn-ghost ${className ?? ''}`}
      onClick={() => copy(text)}
      aria-label={label ? `Copy ${label}` : 'Copy to clipboard'}
    >
      <Icon name={copied ? 'check' : 'copy'} size={13} />
      {label ? <span>{copied ? 'Copied' : failed ? 'Copy failed' : label}</span> : null}
      <span className="sr-only" role="status">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </button>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="code-block">
      {label ? (
        <div className="code-head">
          <span>{label}</span>
          <CopyButton text={code} />
        </div>
      ) : (
        <CopyButton text={code} className="copy-btn" />
      )}
      <pre>{code}</pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  optional,
  htmlFor,
  children
}: {
  label: ReactNode;
  hint?: ReactNode;
  optional?: boolean;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={htmlFor}>
        {label}
        {optional ? <span className="optional">optional</span> : null}
      </label>
      {children}
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

export function CheckRow({
  checked,
  onChange,
  title,
  hint,
  id
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: ReactNode;
  hint?: ReactNode;
  id?: string;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label className="checkrow" htmlFor={inputId}>
      <input id={inputId} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="checkrow-text">
        <span className="checkrow-title">{title}</span>
        {hint ? <span className="hint">{hint}</span> : null}
      </span>
    </label>
  );
}

export function RangeField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  hint
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  format?: (value: number) => string;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="range-row">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <output className="range-value" htmlFor={id}>
          {format ? format(value) : value}
        </output>
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Tabs / progress / key-value
// ---------------------------------------------------------------------------

export type TabDef = { id: string; label: string; count?: number };

export function Tabs({ tabs, active, onChange }: { tabs: TabDef[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs" role="tablist" aria-label="Sections">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={active === tab.id}
          aria-controls={`panel-${tab.id}`}
          className={`tab ${active === tab.id ? 'active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {typeof tab.count === 'number' ? <span className="tab-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Progress({ percent, label, value }: { percent: number; label?: ReactNode; value?: ReactNode }) {
  return (
    <div>
      {label || value ? (
        <div className="progress-meta">
          <span>{label}</span>
          <span className="num">{value}</span>
        </div>
      ) : null}
      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-label="Demo progress"
      >
        <div className="progress-bar" style={{ width: `${Math.max(2, percent)}%` }} />
      </div>
    </div>
  );
}

export function KeyValue({ rows }: { rows: Array<{ key: string; value: ReactNode }> }) {
  return (
    <div className="kv">
      {rows.map((row) => (
        <div className="kv-row" key={row.key}>
          <span className="kv-key">{row.key}</span>
          <span className="kv-val">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

export function SectionHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="row-between" style={{ marginBottom: 12 }}>
      <div>
        <h2 className="section-title">{title}</h2>
        {sub ? <p className="hint" style={{ marginTop: 3 }}>{sub}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}
