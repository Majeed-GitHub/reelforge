import { useEffect, useState } from 'react';
import type { ArticleChannel, ArticleRow, EnvironmentRow, FlowRow } from '@core';
import { api } from '../api.ts';
import { channelLabel, formatRelative, hostOf, truncate } from '../format.ts';
import { useLoader, useNow } from '../hooks.ts';
import { href, navigate } from '../router.ts';
import { Markdown } from '../components/Markdown.tsx';
import {
  ArticleStatusPill,
  Banner,
  ChannelPill,
  EmptyState,
  ErrorPanel,
  Field,
  SkeletonRows
} from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';

type Mode = 'preview' | 'edit';

export function ArticlesScreen({ id }: { id?: string }) {
  const articles = useLoader(() => api.articles.list(), []);
  const rows = articles.data ?? [];
  const selectedId = id || rows[0]?.id || '';

  const detail = useLoader<ArticleRow | null>(
    () =>
      selectedId
        ? api.articles
            .get(selectedId)
            .then((article) => (article && article.id ? article : rows.find((row) => row.id === selectedId) ?? null))
            .catch(() => rows.find((row) => row.id === selectedId) ?? null)
        : Promise.resolve(null),
    [selectedId]
  );

  const article = detail.data;
  useNow(30_000);

  const [mode, setMode] = useState<Mode>('preview');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftExcerpt, setDraftExcerpt] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [draftChannel, setDraftChannel] = useState<ArticleChannel>('help_center');
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setMode('preview');
    setActionError(null);
    setSavedAt(null);
  }, [selectedId]);

  useEffect(() => {
    if (!article) return;
    setDraftTitle(article.title ?? '');
    setDraftExcerpt(article.excerpt ?? '');
    setDraftBody(article.body_md ?? '');
    setDraftChannel(article.channel ?? 'help_center');
  }, [article?.id, article?.updated_at, article?.title, article?.excerpt, article?.body_md, article?.channel]);

  async function save() {
    if (!selectedId) return;
    setSaving(true);
    setActionError(null);
    try {
      await api.articles.update(selectedId, {
        title: draftTitle.trim(),
        excerpt: draftExcerpt.trim(),
        body_md: draftBody,
        channel: draftChannel
      });
      setSavedAt(Date.now());
      setMode('preview');
      articles.reload();
      detail.reload();
    } catch (cause) {
      setActionError(cause);
    } finally {
      setSaving(false);
    }
  }

  async function setPublished(publish: boolean) {
    if (!selectedId) return;
    setPublishing(true);
    setActionError(null);
    try {
      if (publish) await api.articles.publish(selectedId);
      else await api.articles.unpublish(selectedId);
      articles.reload();
      detail.reload();
    } catch (cause) {
      setActionError(cause);
    } finally {
      setPublishing(false);
    }
  }

  if (articles.loading) {
    return (
      <div className="card">
        <SkeletonRows rows={6} />
      </div>
    );
  }

  if (articles.error) {
    return (
      <div className="stack">
        <PageHead onCreated={() => articles.reload()} />
        <ErrorPanel error={articles.error} onRetry={articles.reload} what="articles" />
      </div>
    );
  }

  return (
    <div>
      <PageHead onCreated={(createdId) => navigate(href.articles(createdId))} />

      {rows.length === 0 ? (
        <EmptyState
          icon="articles"
          title="No articles yet"
          body="A completed demo writes a help-centre article and an internal-training doc from the flow it recorded. You can also write one from any flow in the Product Graph."
          action={
            <a className="btn btn-primary" href={href.graph()}>
              <Icon name="graph" size={14} />
              Open the Product Graph
            </a>
          }
          hint="Drafts stay editable here; publishing flips the status and, when configured, syncs to your helpdesk."
        />
      ) : (
        <div className="split-320">
          <section className="card">
            <div className="card-head">
              <h2 className="section-title">Library</h2>
              <span className="hint num">{rows.length}</span>
            </div>
            <div className="card-body" style={{ padding: 10 }}>
              <div className="flow-list">
                {rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className={`flow-item ${row.id === selectedId ? 'active' : ''}`}
                    onClick={() => navigate(href.articles(row.id))}
                    aria-current={row.id === selectedId ? 'true' : undefined}
                  >
                    <span className="flow-item-name" title={row.title}>
                      {row.title}
                    </span>
                    <span className="flow-item-meta" style={{ gap: 6 }}>
                      <ChannelPill channel={row.channel} />
                      <ArticleStatusPill status={row.status} />
                    </span>
                    <span className="hint">updated {formatRelative(row.updated_at)}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="stack">
            {detail.loading ? (
              <div className="card">
                <SkeletonRows rows={8} />
              </div>
            ) : detail.error ? (
              <ErrorPanel error={detail.error} onRetry={detail.reload} what="this article" />
            ) : !article ? (
              <EmptyState icon="articles" title="Select an article" body="Pick a draft or a published article from the library." />
            ) : (
              <article className="card">
                <div className="card-head" style={{ alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row wrap" style={{ marginBottom: 6 }}>
                      <ChannelPill channel={article.channel} />
                      <ArticleStatusPill status={article.status} />
                      <span className="hint mono">/{article.slug}</span>
                    </div>
                    <h2 className="section-title" style={{ fontSize: 18, maxWidth: '60ch' }}>
                      {mode === 'edit' ? draftTitle || article.title : article.title}
                    </h2>
                    <p className="hint" style={{ marginTop: 3 }}>
                      Updated {formatRelative(article.updated_at)} · created {formatRelative(article.created_at)}
                      {article.environment_id ? ` · ${truncate(article.environment_id, 18)}` : ''}
                    </p>
                  </div>
                  <div className="row" style={{ flexShrink: 0 }}>
                    <div className="seg" role="group" aria-label="Article view">
                      <button type="button" className="seg-btn" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
                        Preview
                      </button>
                      <button type="button" className="seg-btn" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>
                        Edit
                      </button>
                    </div>
                    {article.status === 'published' ? (
                      <button type="button" className="btn btn-sm" onClick={() => setPublished(false)} disabled={publishing}>
                        {publishing ? <Icon name="refresh" size={13} className="spin" /> : null}
                        Unpublish
                      </button>
                    ) : (
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => setPublished(true)} disabled={publishing}>
                        {publishing ? <Icon name="refresh" size={13} className="spin" /> : <Icon name="upload" size={13} />}
                        Publish
                      </button>
                    )}
                  </div>
                </div>

                <div className="card-body stack">
                  {savedAt ? (
                    <Banner tone="ok" title="Saved">
                      <p>Changes are stored on the article and the list reflects them immediately.</p>
                    </Banner>
                  ) : null}

                  {actionError ? <ErrorPanel error={actionError} what="update the article" /> : null}

                  {article.published_url ? (
                    <p className="hint">
                      Published at{' '}
                      <a className="link" href={article.published_url} target="_blank" rel="noreferrer">
                        {article.published_url}
                      </a>
                    </p>
                  ) : null}

                  {mode === 'preview' ? (
                    <>
                      {article.excerpt ? <p className="note">{article.excerpt}</p> : null}
                      <Markdown source={article.body_md} />
                    </>
                  ) : (
                    <div className="stack">
                      <div className="grid-2">
                        <Field label="Title" htmlFor="article-title">
                          <input
                            id="article-title"
                            className="input"
                            value={draftTitle}
                            onChange={(event) => setDraftTitle(event.target.value)}
                          />
                        </Field>
                        <Field label="Channel" htmlFor="article-channel" hint="Help centre is customer-facing; internal training is for your team.">
                          <select
                            id="article-channel"
                            className="select"
                            value={draftChannel}
                            onChange={(event) => setDraftChannel(event.target.value as ArticleChannel)}
                          >
                            <option value="help_center">{channelLabel('help_center')}</option>
                            <option value="internal_training">{channelLabel('internal_training')}</option>
                          </select>
                        </Field>
                      </div>
                      <Field label="Excerpt" htmlFor="article-excerpt" hint="One line shown in the help centre index.">
                        <input
                          id="article-excerpt"
                          className="input"
                          value={draftExcerpt}
                          onChange={(event) => setDraftExcerpt(event.target.value)}
                        />
                      </Field>
                      <Field label="Body (Markdown)" htmlFor="article-body" hint="Rendered with marked. Images and links are scrubbed before display.">
                        <textarea
                          id="article-body"
                          className="textarea mono"
                          rows={20}
                          value={draftBody}
                          onChange={(event) => setDraftBody(event.target.value)}
                          spellCheck={false}
                        />
                      </Field>
                      <div className="form-actions">
                        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
                          {saving ? <Icon name="refresh" size={14} className="spin" /> : <Icon name="check" size={14} />}
                          {saving ? 'Saving…' : 'Save changes'}
                        </button>
                        <button type="button" className="btn btn-ghost" onClick={() => setMode('preview')} disabled={saving}>
                          Discard
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </article>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function PageHead({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Articles</h1>
          <p className="page-sub">
            The same recorded flow written two ways: a customer-facing help-centre article and an internal runbook. Both are
            editable Markdown and both go stale when the graph does.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setOpen((value) => !value)}>
          {open ? <Icon name="close" size={14} /> : <Icon name="articles" size={14} />}
          {open ? 'Close' : 'Create from flow'}
        </button>
      </div>
      {open ? <CreateFromFlow onCreated={onCreated} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CreateFromFlow({ onCreated, onClose }: { onCreated: (id: string) => void; onClose: () => void }) {
  const environments = useLoader(
    () => api.environments.list().catch((): EnvironmentRow[] => []),
    []
  );
  const [environmentId, setEnvironmentId] = useState('');
  const environmentList = environments.data ?? [];
  const selectedEnvironmentId = environmentId || environmentList[0]?.id || '';

  const flows = useLoader(
    () => (selectedEnvironmentId ? api.graph.flows(selectedEnvironmentId).catch((): FlowRow[] => []) : Promise.resolve([] as FlowRow[])),
    [selectedEnvironmentId]
  );
  const flowList = flows.data ?? [];
  const [flowId, setFlowId] = useState('');
  const selectedFlowId = flowId || flowList[0]?.id || '';

  const [channel, setChannel] = useState<ArticleChannel>('help_center');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function create() {
    if (!selectedFlowId) return;
    setCreating(true);
    setError(null);
    try {
      const article = await api.articles.fromFlow({ flowId: selectedFlowId, channel, environmentId: selectedEnvironmentId });
      if (article.id) {
        onCreated(article.id);
        onClose();
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="card" style={{ marginBottom: 20 }}>
      <div className="card-head">
        <h2 className="section-title">Create an article from a flow</h2>
        <span className="hint">No model credentials needed — the template writes it</span>
      </div>
      <div className="card-body stack">
        {environmentList.length === 0 ? (
          <EmptyState
            icon="graph"
            title="No environments to read flows from"
            body="Flows belong to environments. Add one and record a demo first."
            action={
              <a className="btn btn-sm" href={href.environments()}>
                Add environment
              </a>
            }
          />
        ) : (
          <>
            <div className="grid-3">
              <Field label="Environment" htmlFor="flow-env">
                <select
                  id="flow-env"
                  className="select"
                  value={selectedEnvironmentId}
                  onChange={(event) => {
                    setEnvironmentId(event.target.value);
                    setFlowId('');
                  }}
                >
                  {environmentList.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environment.name} · {hostOf(environment.base_url)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Flow" htmlFor="flow-pick" hint={flowList.length === 0 ? 'No flows recorded for this environment yet.' : undefined}>
                <select
                  id="flow-pick"
                  className="select"
                  value={selectedFlowId}
                  onChange={(event) => setFlowId(event.target.value)}
                  disabled={flowList.length === 0}
                >
                  {flowList.map((flow) => (
                    <option key={flow.id} value={flow.id}>
                      {flow.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Channel" htmlFor="flow-channel">
                <select
                  id="flow-channel"
                  className="select"
                  value={channel}
                  onChange={(event) => setChannel(event.target.value as ArticleChannel)}
                >
                  <option value="help_center">{channelLabel('help_center')}</option>
                  <option value="internal_training">{channelLabel('internal_training')}</option>
                </select>
              </Field>
            </div>

            {error ? <ErrorPanel error={error} what="create the article" /> : null}

            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={create} disabled={creating || !selectedFlowId}>
                {creating ? <Icon name="refresh" size={14} className="spin" /> : <Icon name="check" size={14} />}
                {creating ? 'Writing…' : 'Write article'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
