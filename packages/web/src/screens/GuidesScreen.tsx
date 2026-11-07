import { useMemo, useState } from 'react';
import type { GuideRow } from '@core';
import { api, apiOrigin } from '../api.ts';
import { formatRelative, parseJsonField, truncate } from '../format.ts';
import { useLoader, useNow } from '../hooks.ts';
import { usePrivacy } from '../privacy.ts';
import { href, navigate } from '../router.ts';
import { Privacy } from '../components/Privacy.tsx';
import {
  Banner,
  CodeBlock,
  EmptyState,
  ErrorPanel,
  KeyValue,
  Pill,
  SkeletonRows
} from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';

type GuideStep = {
  idx: number;
  selector?: string | null;
  role?: string | null;
  name?: string | null;
  title: string;
  body: string;
  url?: string | null;
};

export function GuidesScreen({ id }: { id?: string }) {
  const guides = useLoader(() => api.guides.list(), []);
  const rows = guides.data ?? [];
  const selectedId = id || rows[0]?.id || '';

  const detail = useLoader<GuideRow | null>(
    () =>
      selectedId
        ? api.guides
            .get(selectedId)
            .then((guide) => (guide && guide.id ? guide : rows.find((row) => row.id === selectedId) ?? null))
            .catch(() => rows.find((row) => row.id === selectedId) ?? null)
        : Promise.resolve(null),
    [selectedId]
  );

  const guide = detail.data;
  useNow(30_000);
  const privacy = usePrivacy();

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const steps = useMemo(() => parseJsonField<GuideStep[]>(guide?.steps_json) ?? [], [guide?.steps_json]);
  const origin = apiOrigin();
  const snippet = guide
    ? `<script src="${origin}/g/guide.js" data-guide="${guide.embed_key}" async></script>`
    : '';
  const previewUrl = guide ? `${origin}/g/demo.html?key=${encodeURIComponent(guide.embed_key)}` : '';
  const live = guide?.status === 'live';

  async function toggleLive() {
    if (!guide) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.guides.setLive(guide.id, !live);
      guides.reload();
      detail.reload();
    } catch (cause) {
      setActionError(cause);
    } finally {
      setBusy(false);
    }
  }

  if (guides.loading) {
    return (
      <div className="card">
        <SkeletonRows rows={5} />
      </div>
    );
  }

  if (guides.error) {
    return (
      <div className="stack">
        <PageHead />
        <ErrorPanel error={guides.error} onRetry={guides.reload} what="guides" />
      </div>
    );
  }

  return (
    <div>
      <PageHead />

      {rows.length === 0 ? (
        <EmptyState
          icon="guides"
          title="No in-app guides yet"
          body="A completed demo drafts a guide: one step per recorded action, each with the selector the browser agent used. Publish it, then embed it in your product with one script tag."
          action={
            <a className="btn btn-primary" href={href.graph()}>
              <Icon name="graph" size={14} />
              Open the Product Graph
            </a>
          }
          hint="Guides are built from flows, so they need an environment with at least one recorded demo."
        />
      ) : (
        <div className="split-320">
          <section className="card">
            <div className="card-head">
              <h2 className="section-title">Guides</h2>
              <span className="hint num">{rows.length}</span>
            </div>
            <div className="card-body" style={{ padding: 10 }}>
              <div className="flow-list">
                {rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className={`flow-item ${row.id === selectedId ? 'active' : ''}`}
                    onClick={() => navigate(href.guides(row.id))}
                    aria-current={row.id === selectedId ? 'true' : undefined}
                  >
                    <span className="flow-item-name" title={privacy ? undefined : row.name}>
                      <Privacy label="guide name">{row.name}</Privacy>
                    </span>
                    <span className="flow-item-meta">
                      <Pill tone={row.status === 'live' ? 'good' : 'draft'} dot={row.status === 'live'}>
                        {row.status === 'live' ? 'Live' : 'Draft'}
                      </Pill>
                      <span className="mono" style={{ fontSize: 11 }}>
                        <Privacy label="guide embed key">{truncate(row.embed_key, 16)}</Privacy>
                      </span>
                    </span>
                    <span className="hint">updated {formatRelative(row.updated_at)}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="stack-lg">
            {detail.loading ? (
              <div className="card">
                <SkeletonRows rows={6} />
              </div>
            ) : detail.error ? (
              <ErrorPanel error={detail.error} onRetry={detail.reload} what="this guide" />
            ) : !guide ? (
              <EmptyState icon="guides" title="Select a guide" body="Pick a guide on the left to see its embed snippet and steps." />
            ) : (
              <>
                <section className="card">
                  <div className="card-head">
                    <div>
                      <div className="row wrap" style={{ marginBottom: 4 }}>
                        <Pill tone={live ? 'good' : 'draft'} dot={live}>
                          {live ? 'Live' : 'Draft'}
                        </Pill>
                        <span className="hint mono">
                          embed key <Privacy label="guide embed key">{guide.embed_key}</Privacy>
                        </span>
                      </div>
                      <h2 className="section-title" style={{ fontSize: 18 }}>
                        <Privacy label="guide name">{guide.name}</Privacy>
                      </h2>
                      <p className="hint" style={{ marginTop: 3 }}>
                        {steps.length} step{steps.length === 1 ? '' : 's'} · updated {formatRelative(guide.updated_at)}
                      </p>
                    </div>
                    <div className="row" style={{ flexShrink: 0 }}>
                      <a className="btn btn-sm" href={previewUrl} target="_blank" rel="noreferrer">
                        <Icon name="external" size={13} />
                        Preview
                      </a>
                      <button type="button" className={`btn btn-sm ${live ? '' : 'btn-primary'}`} onClick={toggleLive} disabled={busy}>
                        {busy ? <Icon name="refresh" size={13} className="spin" /> : <Icon name="upload" size={13} />}
                        {live ? 'Unpublish' : 'Publish'}
                      </button>
                    </div>
                  </div>
                  <div className="card-body stack">
                    {actionError ? <ErrorPanel error={actionError} what="update the guide" /> : null}

                    <div>
                      <p className="eyebrow" style={{ marginBottom: 8 }}>
                        Embed snippet
                      </p>
                      <Privacy variant="block" label="guide embed snippet">
                        <CodeBlock code={snippet} label="Paste before </body> on every page the guide should run on" />
                      </Privacy>
                      <p className="hint" style={{ marginTop: 8 }}>
                        The widget fetches <code>GET /api/guides/embed/{guide.embed_key}</code> from the script's own origin, so the
                        same snippet works on any domain you serve. It renders inside a shadow root — no style leaks either way — and
                        it never navigates your page.
                      </p>
                    </div>

                    <Banner tone="info" title="How a step finds its target">
                      <p>
                        The widget tries <code>[data-testid]</code> from the recorded selector, then a role + accessible-name match,
                        then the selector itself. A step that cannot be resolved is skipped, the walk continues, and the skip is
                        reported to <code>POST /api/guides/{guide.id}/report</code> — users are never blocked by a stale selector.
                      </p>
                    </Banner>
                  </div>
                </section>

                <section className="card">
                  <div className="card-head">
                    <h2 className="section-title">Steps</h2>
                    <span className="hint num">{steps.length}</span>
                  </div>
                  <div className="card-body">
                    {steps.length === 0 ? (
                      <EmptyState
                        icon="guides"
                        title="This guide has no steps"
                        body="Guides are drafted from recorded flows. Re-record the flow, then re-check the Product Graph."
                      />
                    ) : (
                      <div className="step-list">
                        {steps.map((step, index) => (
                          <div className="step-row" key={`${step.idx}-${index}`} style={{ gridTemplateColumns: '26px minmax(0, 1fr) auto' }}>
                            <span className="step-idx">{index + 1}</span>
                            <div className="step-narration">
                              <div style={{ fontWeight: 550 }}>{step.title || `Step ${index + 1}`}</div>
                              <div className="hint" style={{ marginTop: 2 }}>
                                {step.body}
                              </div>
                              <div className="step-sel" style={{ marginTop: 4 }}>
                                {step.selector ?? (step.role ? `${step.role}${step.name ? ` "${step.name}"` : ''}` : 'no selector')}
                                {step.url ? ` · ${step.url}` : ''}
                              </div>
                            </div>
                            <span className="step-kind">{step.role ?? 'target'}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </section>

                <section className="card card-pad stack">
                  <h2 className="section-title">Guide record</h2>
                  <KeyValue
                    rows={[
                      { key: 'ID', value: <span className="mono">{guide.id}</span> },
                      { key: 'Status', value: <Pill tone={live ? 'good' : 'draft'}>{live ? 'Live' : 'Draft'}</Pill> },
                      { key: 'Embed key', value: <Privacy label="guide embed key"><span className="mono">{guide.embed_key}</span></Privacy> },
                      { key: 'Environment', value: guide.environment_id },
                      { key: 'Flow', value: guide.flow_id ?? <span className="dim">—</span> },
                      { key: 'Created', value: formatRelative(guide.created_at) },
                      { key: 'Updated', value: formatRelative(guide.updated_at) }
                    ]}
                  />
                  <p className="note">
                    “Don't show again” is stored per guide in the visitor's browser, so a dismiss is local, instant and revocable
                    only by clearing storage. The widget also stops on Esc and walks with ← / →.
                  </p>
                </section>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function PageHead() {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">Guides</h1>
        <p className="page-sub">
          Spotlight walkthroughs that live inside your product. One script tag, no framework, no CSS collisions, no navigation away
          from the user's task.
        </p>
      </div>
    </div>
  );
}
