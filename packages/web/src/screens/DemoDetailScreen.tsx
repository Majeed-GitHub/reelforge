import { useMemo, useState } from 'react';
import type { DemoFailure, DemoOutcome, DemoQuestion, NarrationLine } from '@core';
import { api, isNetworkError } from '../api.ts';
import type { CreateDemoBody } from '../api.ts';
import {
  formatDateTime,
  formatDuration,
  formatMsClock,
  formatNumber,
  formatRelative,
  hostOf,
  parseJsonField,
  pipelineStage,
  prettyJson,
  toPercent
} from '../format.ts';
import { confirmAction, useLoader, usePolling } from '../hooks.ts';
import { href, navigate } from '../router.ts';
import {
  Banner,
  CodeBlock,
  DemoStatusPill,
  EmptyState,
  ErrorPanel,
  KeyValue,
  Progress,
  SkeletonRows,
  Tabs
} from '../components/ui.tsx';
import type { TabDef } from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';

type TabId = 'steps' | 'transcript' | 'raw';

export function DemoDetailScreen({ id }: { id: string }) {
  const demo = useLoader(() => api.demos.get(id), [id]);
  const data = demo.data;
  const status = data?.status ?? 'queued';
  const running = status === 'queued' || status === 'running';

  usePolling(demo.reload, running ? 2000 : null);

  const transcriptStatus = data?.status ?? '';
  const transcript = useLoader(
    () =>
      transcriptStatus === 'complete'
        ? api.demos.transcript(id).catch((): NarrationLine[] => [])
        : Promise.resolve([] as NarrationLine[]),
    [id, transcriptStatus]
  );

  const [tab, setTab] = useState<TabId>('steps');
  const [answering, setAnswering] = useState<string | null>(null);
  const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const outcome = useMemo(() => parseJsonField<DemoOutcome>(data?.outcome), [data?.outcome]);
  const failure = useMemo(() => parseJsonField<DemoFailure>(data?.failure), [data?.failure]);
  const question = useMemo(() => parseJsonField<DemoQuestion>(data?.question), [data?.question]);
  const steps = data?.steps ?? [];
  const percent = status === 'complete' ? 100 : toPercent(data?.progress);

  async function answer(optionId: string) {
    setAnswering(optionId);
    setActionError(null);
    try {
      await api.demos.answer(id, optionId);
      demo.reload();
    } catch (cause) {
      setActionError(cause);
    } finally {
      setAnswering(null);
    }
  }

  async function cancel() {
    if (!confirmAction('Cancel this run? The partial recording is discarded.')) return;
    setBusy('cancel');
    setActionError(null);
    try {
      await api.demos.cancel(id);
      demo.reload();
    } catch (cause) {
      setActionError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function retry() {
    if (!data) return;
    setBusy('retry');
    setActionError(null);
    try {
      const storedOptions = parseJsonField<Record<string, unknown>>(data.options_json) ?? {};
      const body: CreateDemoBody = {
        instruction: data.instruction,
        authorized: true,
        options: storedOptions as NonNullable<CreateDemoBody['options']>
      };
      if (data.environment_id) body.environmentId = data.environment_id;
      else body.target = { type: data.target_type ?? 'url', url: data.target_url };
      const created = await api.demos.create(body);
      if (!created.id) throw new Error('The API returned no demo id for the retry.');
      navigate(href.demo(created.id));
    } catch (cause) {
      setActionError(cause);
      setBusy(null);
    }
  }

  if (demo.loading) {
    return (
      <div className="stack">
        <div className="sk sk-line" style={{ height: 30, width: 320 }} />
        <div className="card">
          <SkeletonRows rows={6} />
        </div>
      </div>
    );
  }

  if (demo.error) {
    return (
      <div className="stack">
        <a className="row hint" href={href.demos()} style={{ gap: 6, color: 'var(--text-3)' }}>
          <Icon name="arrow-left" size={13} />
          All demos
        </a>
        <ErrorPanel error={demo.error} onRetry={demo.reload} what="this demo" />
      </div>
    );
  }

  if (!data) return null;

  const tabs: TabDef[] = [
    { id: 'steps', label: 'Steps', count: steps.length },
    { id: 'transcript', label: 'Transcript', count: transcript.data?.length ?? 0 },
    { id: 'raw', label: 'Raw' }
  ];

  return (
    <div>
      <a className="row hint" href={href.demos()} style={{ marginBottom: 10, gap: 6, color: 'var(--text-3)' }}>
        <Icon name="arrow-left" size={13} />
        All demos
      </a>

      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="row wrap" style={{ marginBottom: 8 }}>
            <DemoStatusPill status={data.status} />
            <span className="hint">created {formatRelative(data.created_at)}</span>
            {data.duration_ms ? (
              <>
                <span className="hint dotsep" />
                <span className="hint">{formatDuration(data.duration_ms)}</span>
              </>
            ) : null}
            <span className="hint dotsep" />
            <span className="hint mono" title={data.target_url}>
              {hostOf(data.target_url)}
            </span>
          </div>
          <h1 className="page-title" style={{ maxWidth: '62ch' }}>
            {data.instruction}
          </h1>
          <p className="page-sub mono" style={{ fontSize: 12 }}>
            {data.id} · {data.target_type} target
          </p>
        </div>
        <div className="row" style={{ flexShrink: 0 }}>
          {running ? (
            <button type="button" className="btn btn-danger" onClick={cancel} disabled={busy !== null}>
              {busy === 'cancel' ? <Icon name="refresh" size={14} className="spin" /> : <Icon name="close" size={14} />}
              Cancel
            </button>
          ) : (
            <button type="button" className="btn" onClick={retry} disabled={busy !== null}>
              {busy === 'retry' ? <Icon name="refresh" size={14} className="spin" /> : <Icon name="refresh" size={14} />}
              {status === 'failed' ? 'Retry' : 'Re-record'}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => navigate(href.newDemo())}>
            <Icon name="plus" size={14} />
            New demo
          </button>
        </div>
      </div>

      {actionError ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorPanel error={actionError} what="complete that action" />
        </div>
      ) : null}

      <div className="detail-grid">
        <div className="stack-lg">
          {/* ----------------------------------------------------- progress */}
          {running ? (
            <section className="card card-pad stack">
              <div className="row-between">
                <span className="eyebrow">{status === 'queued' ? 'Waiting for a worker' : 'Recording'}</span>
                <span className="hint num">{percent}%</span>
              </div>
              <Progress percent={percent} label={pipelineStage(status, percent)} value={`${percent}%`} />
              <p className="hint">
                This page polls <code>GET /api/demos/{data.id}</code> every 2 seconds while the run is in flight.
              </p>
            </section>
          ) : null}

          {/* -------------------------------------------------------- video */}
          {status === 'complete' && data.videoUrl ? (
            <section className="stack-sm">
              <div className="player">
                <video
                  key={data.videoUrl}
                  controls
                  preload="metadata"
                  poster={data.posterUrl ?? undefined}
                  aria-label="Recorded demo video"
                >
                  <source src={data.videoUrl} type="video/mp4" />
                  Your browser cannot play this MP4. The signed URL is below in the Raw tab.
                </video>
              </div>
              <div className="row-between">
                <span className="hint mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '62%' }}>
                  {data.videoUrl}
                </span>
                <a className="btn btn-sm btn-ghost" href={data.videoUrl} target="_blank" rel="noreferrer">
                  <Icon name="external" size={13} />
                  Open signed URL
                </a>
              </div>
            </section>
          ) : status === 'complete' ? (
            <section className="card">
              <div className="card-body stack">
                <Banner tone="info" title="The run is complete but no video URL was returned">
                  <p>
                    The API signs video URLs on read. If this stays empty, the render output or the signing secret is missing — check{' '}
                    <code>GET /api/demos/{data.id}</code> in the Raw tab.
                  </p>
                  <div className="banner-actions">
                    <button type="button" className="btn btn-sm" onClick={demo.reload}>
                      <Icon name="refresh" size={13} />
                      Refresh
                    </button>
                  </div>
                </Banner>
              </div>
            </section>
          ) : (
            <div className="player">
              <div className="player-placeholder">
                <Icon name="film" size={22} />
                <span>{status === 'failed' ? 'No video was produced for this run' : 'The recording appears here when the render finishes'}</span>
                <span className="mono" style={{ fontSize: 11 }}>
                  {pipelineStage(status, percent)}
                </span>
              </div>
            </div>
          )}

          {/* ------------------------------------------------------ question */}
          {question ? (
            <Banner tone="warn" title="The planner needs one answer before it can continue">
              <p>{question.prompt}</p>
              <div className="row wrap" style={{ marginTop: 12 }}>
                {question.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="btn btn-sm"
                    onClick={() => answer(option.id)}
                    disabled={answering !== null}
                  >
                    {answering === option.id ? <Icon name="refresh" size={13} className="spin" /> : null}
                    {option.label}
                  </button>
                ))}
              </div>
            </Banner>
          ) : null}

          {/* ------------------------------------------------------- failure */}
          {failure ? (
            <Banner
              tone="error"
              title={
                <span className="row" style={{ gap: 8 }}>
                  <span>Run failed</span>
                  <span className="mono pill pill-failed">{failure.code}</span>
                </span>
              }
              actions={
                <button type="button" className="btn btn-sm" onClick={retry} disabled={busy !== null}>
                  <Icon name="refresh" size={13} />
                  Retry with the same request
                </button>
              }
            >
              <p>{failure.message}</p>
              {failure.remediation ? (
                <div style={{ marginTop: 10 }}>
                  <p style={{ color: 'var(--text)', fontWeight: 600 }}>{failure.remediation.action}</p>
                  {failure.remediation.hint ? <p style={{ marginTop: 3 }}>{failure.remediation.hint}</p> : null}
                </div>
              ) : null}
            </Banner>
          ) : null}

          {/* ------------------------------------------------------- outcome */}
          {outcome ? (
            <section className="card">
              <div className="card-head">
                <h2 className="section-title">Outcome</h2>
                <span className={outcome.goalMet ? 'pill pill-complete' : 'pill pill-failed'}>
                  {outcome.goalMet ? 'Goal met' : 'Goal not met'}
                </span>
              </div>
              <div className="card-body stack">
                <div className="grid-3">
                  <Stat label="Steps completed" value={formatNumber(outcome.stepsCompleted)} />
                  <Stat label="Duration" value={formatDuration(data.duration_ms)} />
                  <Stat label="Credits used" value={formatNumber(data.credits_used)} />
                </div>

                {outcome.whatWasShown?.length ? (
                  <div>
                    <p className="eyebrow" style={{ marginBottom: 8 }}>
                      What was shown
                    </p>
                    <ul className="list-reset">
                      {outcome.whatWasShown.map((item) => (
                        <li key={item} className="row" style={{ alignItems: 'flex-start', gap: 8, fontSize: 13.5 }}>
                          <span style={{ color: 'var(--good)', marginTop: 2 }}>
                            <Icon name="check" size={13} />
                          </span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {outcome.stoppedBefore ? (
                  <Banner tone="warn" title="Stopped before a step it was not cleared to take">
                    <p className="mono" style={{ fontSize: 12 }}>
                      {outcome.stoppedBefore}
                    </p>
                    <p style={{ marginTop: 6 }}>
                      Re-record with “Allow destructive steps” if this run should go further.
                    </p>
                  </Banner>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* ---------------------------------------------------------- tabs */}
          <section>
            <Tabs tabs={tabs} active={tab} onChange={(next) => setTab(next as TabId)} />

            {tab === 'steps' ? (
              <div id="panel-steps" role="tabpanel" aria-labelledby="tab-steps">
                {steps.length === 0 ? (
                  <EmptyState
                    icon="film"
                    title={running ? 'No steps captured yet' : 'This run recorded no steps'}
                    body={
                      running
                        ? 'Steps appear here as the browser agent performs them, with a screenshot thumbnail and the selector it used.'
                        : 'A run with zero steps usually means the planner never reached the page — check the failure panel above.'
                    }
                  />
                ) : (
                  <div className="card" style={{ padding: '4px 18px' }}>
                    <div className="step-list">
                      {steps.map((step) => (
                        <div className="step-row" key={`${step.idx}-${step.selector ?? ''}`}>
                          <span className="step-idx">{step.idx}</span>
                          <span className="step-kind">{step.kind}</span>
                          <div className="step-narration">
                            <div>{step.narration || <span className="dim">—</span>}</div>
                            <div className="step-sel" title={step.selector ?? undefined}>
                              {step.selector ?? step.role ?? '—'}
                              {step.url ? ` · ${hostOf(step.url)}` : ''}
                            </div>
                          </div>
                          {step.screenshotUrl ? (
                            <a
                              className="thumb"
                              href={step.screenshotUrl}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`Open screenshot for step ${step.idx}`}
                            >
                              <img src={step.screenshotUrl} alt={`Step ${step.idx} screenshot`} loading="lazy" />
                            </a>
                          ) : (
                            <span className="thumb" aria-hidden="true">
                              <span className="thumb-empty">no shot</span>
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {tab === 'transcript' ? (
              <div id="panel-transcript" role="tabpanel" aria-labelledby="tab-transcript">
                {transcript.loading ? (
                  <div className="card">
                    <SkeletonRows rows={4} />
                  </div>
                ) : (transcript.data?.length ?? 0) === 0 ? (
                  <EmptyState
                    icon="articles"
                    title="No narration yet"
                    body="The transcript is written after the render, when each spoken line has a measured duration and a start offset."
                  />
                ) : (
                  <div className="card" style={{ padding: '4px 18px' }}>
                    <div className="transcript">
                      {[...(transcript.data ?? [])]
                        .sort((a, b) => a.startMs - b.startMs)
                        .map((line) => (
                          <div className="transcript-line" key={`${line.stepIndex}-${line.startMs}`}>
                            <span className="transcript-time">{formatMsClock(line.startMs)}</span>
                            <div>
                              <div>{line.text}</div>
                              <div className="hint">
                                step {line.stepIndex} · {formatDuration(line.durationMs)} of audio
                              </div>
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {tab === 'raw' ? (
              <div id="panel-raw" role="tabpanel" aria-labelledby="tab-raw" className="stack">
                <CodeBlock code={prettyJson(data)} label={`GET /api/demos/${data.id}`} />
              </div>
            ) : null}
          </section>
        </div>

        {/* ---------------------------------------------------------- aside */}
        <aside className="stack">
          <section className="card card-pad stack">
            <h2 className="section-title">Run</h2>
            <KeyValue
              rows={[
                { key: 'Status', value: <DemoStatusPill status={data.status} /> },
                { key: 'Progress', value: <span className="num">{percent}%</span> },
                { key: 'Duration', value: <span className="num">{formatDuration(data.duration_ms)}</span> },
                { key: 'Credits', value: <span className="num">{formatNumber(data.credits_used)}</span> },
                { key: 'Steps', value: <span className="num">{formatNumber(steps.length)}</span> },
                { key: 'Created', value: formatDateTime(data.created_at) },
                { key: 'Started', value: formatDateTime(data.started_at) },
                { key: 'Finished', value: formatDateTime(data.finished_at) },
                { key: 'Environment', value: data.environment_id ?? <span className="dim">one-off URL</span> },
                {
                  key: 'Target',
                  value: (
                    <a className="link mono" href={data.target_url} target="_blank" rel="noreferrer" style={{ fontSize: 11.5 }}>
                      {hostOf(data.target_url)}
                    </a>
                  )
                }
              ]}
            />
          </section>

          <section className="card card-pad stack-sm">
            <h2 className="section-title">From this run</h2>
            <p className="hint">
              A completed demo upserts its flows into the Product Graph, then writes a help-centre article and a guide draft from
              them.
            </p>
            <div className="row wrap">
              <a className="btn btn-sm" href={href.graph()}>
                <Icon name="graph" size={13} />
                Product Graph
              </a>
              <a className="btn btn-sm" href={href.articles()}>
                <Icon name="articles" size={13} />
                Articles
              </a>
              <a className="btn btn-sm" href={href.guides()}>
                <Icon name="guides" size={13} />
                Guides
              </a>
            </div>
          </section>

          {isNetworkError(demo.error) ? null : null}
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <p style={{ fontSize: 21, fontWeight: 620, letterSpacing: '-0.02em', marginTop: 4 }} className="num">
        {value}
      </p>
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}
