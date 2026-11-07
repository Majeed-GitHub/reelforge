import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ArticleChannel, FlowRow } from '@core';
import { api } from '../api.ts';
import type { FlowDetail, ReverifyResult } from '../api.ts';
import { formatRelative, hostOf, truncate } from '../format.ts';
import { useLoader } from '../hooks.ts';
import { href, navigate } from '../router.ts';
import {
  Banner,
  EmptyState,
  ErrorPanel,
  FlowStatusPill,
  KeyValue,
  SectionHeader,
  SkeletonRows
} from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';

type FlowView = FlowRow & { stepCount?: number };

export function GraphScreen({ envId, flowId }: { envId?: string; flowId?: string }) {
  const environments = useLoader(() => api.environments.list(), []);
  const environmentList = environments.data ?? [];
  const selectedEnvId = envId || environmentList[0]?.id || '';

  useEffect(() => {
    if (!envId && environmentList.length > 0) navigate(href.graph(environmentList[0].id));
  }, [envId, environmentList]);

  const flows = useLoader<FlowView[]>(
    () => (selectedEnvId ? api.graph.flows(selectedEnvId) : Promise.resolve([] as FlowView[])),
    [selectedEnvId]
  );
  const flowList = flows.data ?? [];
  const selectedFlowId = flowId || flowList[0]?.id || '';

  const detail = useLoader<FlowDetail | null>(
    () => (selectedEnvId && selectedFlowId ? api.graph.flow(selectedEnvId, selectedFlowId) : Promise.resolve(null)),
    [selectedEnvId, selectedFlowId]
  );

  const [reverifying, setReverifying] = useState(false);
  const [reverifyResult, setReverifyResult] = useState<ReverifyResult | null>(null);
  const [reverifyError, setReverifyError] = useState<unknown>(null);
  const [writing, setWriting] = useState(false);
  const [articleChannel, setArticleChannel] = useState<ArticleChannel>('help_center');
  const [articleError, setArticleError] = useState<unknown>(null);
  const [articleCreated, setArticleCreated] = useState<string | null>(null);

  useEffect(() => {
    setReverifyResult(null);
    setReverifyError(null);
    setArticleError(null);
    setArticleCreated(null);
  }, [selectedFlowId]);

  const selectedEnvironment = environmentList.find((environment) => environment.id === selectedEnvId);
  const currentFlow = detail.data?.flow ?? flowList.find((flow) => flow.id === selectedFlowId);
  const steps = detail.data?.steps ?? [];
  const staleIdx = new Set((reverifyResult?.staleSteps ?? []).map((step) => step.idx));

  async function reverify() {
    if (!selectedEnvId || !selectedFlowId) return;
    setReverifying(true);
    setReverifyError(null);
    try {
      const result = await api.graph.reverify(selectedEnvId, selectedFlowId);
      setReverifyResult(result);
      flows.reload();
      detail.reload();
    } catch (cause) {
      setReverifyError(cause);
    } finally {
      setReverifying(false);
    }
  }

  async function writeArticle() {
    if (!selectedFlowId) return;
    setWriting(true);
    setArticleError(null);
    try {
      const created = await api.articles.fromFlow({
        flowId: selectedFlowId,
        channel: articleChannel,
        environmentId: selectedEnvId
      });
      if (created.id) {
        setArticleCreated(created.id);
        navigate(href.articles(created.id));
      }
    } catch (cause) {
      setArticleError(cause);
    } finally {
      setWriting(false);
    }
  }

  if (environments.loading) {
    return (
      <div className="card">
        <SkeletonRows rows={5} />
      </div>
    );
  }

  if (environments.error) {
    return (
      <div className="stack">
        <PageHead />
        <ErrorPanel error={environments.error} onRetry={environments.reload} what="environments" />
      </div>
    );
  }

  if (environmentList.length === 0) {
    return (
      <div className="stack-lg">
        <PageHead />
        <EmptyState
          icon="graph"
          title="No Product Graph yet"
          body="The graph is built from saved environments. Create one, then record a demo against it — every flow Reelforge walks is stored once and re-checked on demand."
          action={
            <a className="btn btn-primary" href={href.environments()}>
              <Icon name="plus" size={14} />
              Add an environment
            </a>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <PageHead>
        <div className="row" style={{ marginTop: 10 }}>
          <label className="eyebrow" htmlFor="env-select">
            Environment
          </label>
          <select
            id="env-select"
            className="select"
            style={{ width: 'auto', minWidth: 240 }}
            value={selectedEnvId}
            onChange={(event) => navigate(href.graph(event.target.value))}
          >
            {environmentList.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name} · {hostOf(environment.base_url)}
              </option>
            ))}
          </select>
          {selectedEnvironment ? <span className="hint mono">{selectedEnvironment.base_url}</span> : null}
        </div>
      </PageHead>

      <div className="split-320">
        {/* ------------------------------------------------------ flow list */}
        <section className="card">
          <div className="card-head">
            <h2 className="section-title">Flows</h2>
            <span className="hint num">{flowList.length}</span>
          </div>
          <div className="card-body" style={{ padding: 10 }}>
            {flows.loading ? (
              <SkeletonRows rows={4} />
            ) : flows.error ? (
              <ErrorPanel error={flows.error} onRetry={flows.reload} what="flows" />
            ) : flowList.length === 0 ? (
              <EmptyState
                icon="graph"
                title="No flows recorded"
                body="Record a demo against this environment and its flows land here, keyed by what the run did rather than when it ran."
                action={
                  <a className="btn btn-sm btn-primary" href={href.newDemo()}>
                    <Icon name="plus" size={13} />
                    New demo
                  </a>
                }
              />
            ) : (
              <div className="flow-list" role="list">
                {flowList.map((flow) => (
                  <button
                    key={flow.id}
                    type="button"
                    role="listitem"
                    className={`flow-item ${flow.id === selectedFlowId ? 'active' : ''}`}
                    onClick={() => navigate(href.graph(selectedEnvId, flow.id))}
                    aria-current={flow.id === selectedFlowId ? 'true' : undefined}
                  >
                    <span className="flow-item-name" title={flow.name}>
                      {flow.name}
                    </span>
                    <span className="flow-item-meta">
                      <FlowStatusPill status={flow.status} />
                      <span>{flow.last_verified_at ? `verified ${formatRelative(flow.last_verified_at)}` : `seen ${formatRelative(flow.first_seen_at)}`}</span>
                      {typeof flow.stepCount === 'number' ? <span className="dotsep">{flow.stepCount} steps</span> : null}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* --------------------------------------------------- flow detail */}
        <section className="stack-lg">
          {detail.loading ? (
            <div className="card">
              <SkeletonRows rows={5} />
            </div>
          ) : detail.error ? (
            <ErrorPanel error={detail.error} onRetry={detail.reload} what="this flow" />
          ) : !currentFlow ? (
            <EmptyState
              icon="graph"
              title="Pick a flow"
              body="Select a flow on the left to see the steps Reelforge recorded, its last verification, and what a re-check would confirm."
            />
          ) : (
            <>
              <section className="card">
                <div className="card-head">
                  <div>
                    <h2 className="section-title">{currentFlow.name}</h2>
                    <p className="hint mono" style={{ marginTop: 2 }}>
                      {currentFlow.id} · signature {currentFlow.signature}
                    </p>
                  </div>
                  <div className="row">
                    <FlowStatusPill status={currentFlow.status} />
                    <button type="button" className="btn btn-sm" onClick={reverify} disabled={reverifying}>
                      {reverifying ? <Icon name="refresh" size={13} className="spin" /> : <Icon name="refresh" size={13} />}
                      {reverifying ? 'Re-checking…' : 'Re-check flow'}
                    </button>
                  </div>
                </div>
                <div className="card-body stack">
                  {currentFlow.stale_reason ? (
                    <Banner tone="warn" title="Why this flow is stale">
                      <p>{currentFlow.stale_reason}</p>
                      <p style={{ marginTop: 6 }}>
                        A re-check resolves every recorded selector without recording. If a step no longer resolves, the flow stays
                        stale and the article built from it is flagged.
                      </p>
                    </Banner>
                  ) : null}

                  {reverifyError ? <ErrorPanel error={reverifyError} what="re-check the flow" /> : null}

                  {reverifyResult ? (
                    <Banner
                      tone={reverifyResult.status === 'fresh' ? 'ok' : 'warn'}
                      title={reverifyResult.status === 'fresh' ? 'Flow verified fresh' : `Flow re-checked: ${reverifyResult.status ?? 'stale'}`}
                    >
                      <p>
                        Checked {formatRelative(reverifyResult.checkedAt ?? new Date().toISOString())}.{' '}
                        {(reverifyResult.staleSteps ?? []).length === 0
                          ? 'Every recorded step resolved.'
                          : `${(reverifyResult.staleSteps ?? []).length} step(s) no longer resolve.`}
                      </p>
                      {(reverifyResult.staleSteps ?? []).length > 0 ? (
                        <ul className="list-reset" style={{ marginTop: 8 }}>
                          {(reverifyResult.staleSteps ?? []).map((step) => (
                            <li key={`${step.idx}-${step.selector ?? ''}`} className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                              <span className="mono dim" style={{ fontSize: 11.5 }}>
                                #{step.idx}
                              </span>
                              <span>
                                <span className="mono" style={{ fontSize: 11.5 }}>
                                  {step.selector ?? '—'}
                                </span>
                                {step.reason ? <span className="hint"> — {step.reason}</span> : null}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </Banner>
                  ) : null}

                  {steps.length === 0 ? (
                    <EmptyState icon="graph" title="No steps stored for this flow" body="The flow exists but its steps were not returned. Try a re-check." />
                  ) : (
                    <div className="step-list">
                      {steps.map((step) => (
                        <div className={`step-row ${staleIdx.has(step.idx) ? 'stale-step' : ''}`} key={`${step.idx}-${step.selector ?? ''}`}>
                          <span className="step-idx">{step.idx}</span>
                          <span className="step-kind">{step.kind}</span>
                          <div className="step-narration">
                            <div>{step.label || step.name || step.selector || '—'}</div>
                            <div className="step-sel" title={step.selector ?? undefined}>
                              {step.selector ?? step.role ?? '—'}
                              {step.url ? ` · ${step.url}` : ''}
                            </div>
                          </div>
                          {staleIdx.has(step.idx) ? <span className="pill pill-failed">stale</span> : <span />}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <div className="detail-grid">
                <section className="card card-pad stack">
                  <SectionHeader title="Write from this flow" sub="The same steps become a customer help article or an internal runbook." />
                  <div className="row wrap">
                    <select
                      className="select"
                      style={{ width: 'auto' }}
                      value={articleChannel}
                      onChange={(event) => setArticleChannel(event.target.value as ArticleChannel)}
                      aria-label="Article channel"
                    >
                      <option value="help_center">Help centre</option>
                      <option value="internal_training">Internal training</option>
                    </select>
                    <button type="button" className="btn btn-primary" onClick={writeArticle} disabled={writing}>
                      {writing ? <Icon name="refresh" size={14} className="spin" /> : <Icon name="articles" size={14} />}
                      {writing ? 'Writing…' : 'Create article'}
                    </button>
                  </div>
                  {articleError ? <ErrorPanel error={articleError} what="write the article" /> : null}
                  {articleCreated ? (
                    <Banner tone="ok" title="Article created">
                      <a className="btn btn-sm" href={href.articles(articleCreated)}>
                        Open article
                      </a>
                    </Banner>
                  ) : null}
                </section>

                <section className="card card-pad stack">
                  <h2 className="section-title">Verification history</h2>
                  <KeyValue
                    rows={[
                      { key: 'Status', value: <FlowStatusPill status={currentFlow.status} /> },
                      { key: 'First seen', value: formatRelative(currentFlow.first_seen_at) },
                      {
                        key: 'Last verified',
                        value: currentFlow.last_verified_at ? formatRelative(currentFlow.last_verified_at) : <span className="dim">never</span>
                      },
                      { key: 'Stale reason', value: currentFlow.stale_reason ?? <span className="dim">—</span> },
                      { key: 'Steps', value: String(steps.length) },
                      { key: 'Signature', value: <span className="mono" style={{ fontSize: 11 }}>{truncate(currentFlow.signature, 18)}</span> }
                    ]}
                  />
                  <p className="note">
                    A flow's identity is a hash of what it does, so re-recording the same route updates this flow instead of
                    duplicating it. Re-checking is free: it resolves selectors without launching a recording.
                  </p>
                </section>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function PageHead({ children }: { children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">Product Graph</h1>
        <p className="page-sub">
          Every flow Reelforge has walked, stored once and re-checkable. Stale means the product moved; a re-check proves it either
          way without spending credits on a recording.
        </p>
        {children}
      </div>
    </div>
  );
}
