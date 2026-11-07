import { useEffect, useState } from 'react';
import { api, apiOrigin, maskKey, plaintextKey } from '../api.ts';
import type { CreatedApiKey } from '../api.ts';
import { formatDateTime, formatRelative } from '../format.ts';
import { confirmAction, useCopy, useLoader } from '../hooks.ts';
import { Banner, CodeBlock, CopyButton, EmptyState, ErrorPanel, Field, KeyValue, Pill, SkeletonRows } from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';

export function SettingsScreen({ apiKey, onKeyChange }: { apiKey: string; onKeyChange: (key: string) => void }) {
  const origin = apiOrigin();
  const health = useLoader(() => api.health().catch(() => null), [apiKey]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">
            Keys for this deployment, the exact requests the API accepts, and the MCP configuration for wiring Reelforge into an
            assistant. Everything here is scoped to the workspace the key belongs to.
          </p>
        </div>
      </div>

      <div className="stack-lg">
        <BrowserKeyCard apiKey={apiKey} onKeyChange={onKeyChange} />
        <ApiKeysCard onUseKey={onKeyChange} />
        <SnippetsCard origin={origin} apiKey={apiKey} />
        <DeploymentCard health={health.data} loading={health.loading} error={health.error} origin={origin} />
      </div>
    </div>
  );
}

function BrowserKeyCard({ apiKey, onKeyChange }: { apiKey: string; onKeyChange: (key: string) => void }) {
  const [draft, setDraft] = useState(apiKey);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(apiKey), [apiKey]);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">This browser</h2>
        <Pill tone={apiKey ? 'good' : 'warn'} dot={!apiKey}>
          {apiKey ? 'Key stored' : 'No key'}
        </Pill>
      </div>
      <div className="card-body stack">
        <p className="hint">
          The dashboard keeps its key in <code>localStorage</code> and sends it as <code>X-API-Key</code> on every request. It is
          never put in a cookie and never leaves this origin.
        </p>
        {apiKey ? (
          <div className="row wrap">
            <span className="mono" style={{ fontSize: 13 }}>
              {maskKey(apiKey)}
            </span>
            <CopyButton text={apiKey} label="Copy key" />
          </div>
        ) : null}
        <div className="grid-2" style={{ alignItems: 'end' }}>
          <Field label="Paste a key" htmlFor="settings-key" hint="Keys start with rg_. The seed script prints one once.">
            <input
              id="settings-key"
              className="input mono"
              type="password"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setSaved(false);
              }}
              placeholder="rg_…"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="row" style={{ paddingBottom: 20 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                onKeyChange(draft.trim());
                setSaved(true);
              }}
              disabled={!draft.trim()}
            >
              <Icon name="check" size={14} />
              Save key
            </button>
            {apiKey ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  onKeyChange('');
                  setDraft('');
                }}
              >
                <Icon name="trash" size={14} />
                Forget
              </button>
            ) : null}
          </div>
        </div>
        {saved ? (
          <Banner tone="ok" title="Key saved">
            <p>Reload a screen to see data for this workspace.</p>
          </Banner>
        ) : null}
      </div>
    </section>
  );
}

function ApiKeysCard({ onUseKey }: { onUseKey: (key: string) => void }) {
  const keys = useLoader(() => api.keys.list(), []);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const plaintext = created ? plaintextKey(created) : '';

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const key = await api.keys.create(name.trim());
      setCreated(key);
      setName('');
      keys.reload();
    } catch (cause) {
      setCreateError(cause);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string, label: string) {
    if (!confirmAction(`Revoke “${label}”? Any client still using it will start receiving 401 UNAUTHORIZED.`)) return;
    setRevoking(id);
    setCreateError(null);
    try {
      await api.keys.revoke(id);
      keys.reload();
    } catch (cause) {
      setCreateError(cause);
    } finally {
      setRevoking(null);
    }
  }

  const rows = keys.data ?? [];

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">API keys</h2>
        <span className="hint num">{rows.length}</span>
      </div>
      <div className="card-body stack">
        <div className="grid-2" style={{ alignItems: 'end' }}>
          <Field label="Create a key" htmlFor="new-key-name" hint="Name it after the client, not the person. Plaintext is shown once.">
            <input
              id="new-key-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="CI pipeline"
            />
          </Field>
          <div className="row" style={{ paddingBottom: 20 }}>
            <button type="button" className="btn" onClick={create} disabled={creating || !name.trim()}>
              {creating ? <Icon name="refresh" size={14} className="spin" /> : <Icon name="plus" size={14} />}
              {creating ? 'Creating…' : 'Create key'}
            </button>
          </div>
        </div>

        {createError ? <ErrorPanel error={createError} what="manage keys" /> : null}

        {created && plaintext ? (
          <Banner tone="warn" title="Copy this key now — it will not be shown again">
            <div className="stack-sm" style={{ marginTop: 8 }}>
              <div className="row wrap">
                <span className="mono" style={{ fontSize: 13, wordBreak: 'break-all' }}>
                  {plaintext}
                </span>
                <CopyButton text={plaintext} label="Copy" />
                <button type="button" className="btn btn-sm btn-primary" onClick={() => onUseKey(plaintext)}>
                  <Icon name="key" size={13} />
                  Use in this browser
                </button>
              </div>
              <p className="hint">
                Stored as a SHA-256 hash by the API. The prefix <code>{created.prefix ?? plaintext.slice(0, 7)}</code> is all that can
                be read back later.
              </p>
            </div>
          </Banner>
        ) : null}

        {keys.loading ? (
          <SkeletonRows rows={3} />
        ) : keys.error ? (
          <ErrorPanel error={keys.error} onRetry={keys.reload} what="API keys" />
        ) : rows.length === 0 ? (
          <EmptyState icon="key" title="No keys listed" body="Create one above, or run npm run seed to provision the default workspace key." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Prefix</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last used</th>
                  <th scope="col">State</th>
                  <th scope="col" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((key) => (
                  <tr key={key.id}>
                    <td className="cell-title">{key.name}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {key.prefix ?? 'rg_…'}
                    </td>
                    <td className="cell-num">{formatDateTime(key.created_at)}</td>
                    <td className="cell-num">{key.last_used_at ? formatRelative(key.last_used_at) : 'never'}</td>
                    <td>
                      {key.revoked_at ? <Pill tone="warn">Revoked</Pill> : <Pill tone="good">Active</Pill>}
                    </td>
                    <td>
                      {key.revoked_at ? null : (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => revoke(key.id, key.name)}
                          disabled={revoking === key.id}
                        >
                          {revoking === key.id ? <Icon name="refresh" size={13} className="spin" /> : <Icon name="trash" size={13} />}
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function SnippetsCard({ origin, apiKey }: { origin: string; apiKey: string }) {
  const { copied, copy } = useCopy();
  const keyExample = apiKey || 'rg_your_key_here';

  const curl = `curl ${origin}/api/demos \\
  -H "X-API-Key: ${keyExample}" \\
  -H "content-type: application/json" \\
  -d '{"instruction":"Create a project, then invite a teammate.","target":{"type":"url","url":"http://127.0.0.1:4402"},"authorized":true}'`;

  const poll = `curl ${origin}/api/demos/$DEMO_ID \\
  -H "X-API-Key: ${keyExample}"`;

  const mcp = `{
  "mcpServers": {
    "reelforge": {
      "type": "http",
      "url": "${origin}/api/mcp",
      "headers": { "X-API-Key": "${keyExample}" }
    }
  }
}`;

  const seed = `# in the repo root
npm run seed
# prints a workspace key once — paste it into Settings`;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Copyable snippets</h2>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => copy([curl, poll, mcp, seed].join('\n\n'))}>
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          {copied ? 'Copied all' : 'Copy all'}
        </button>
      </div>
      <div className="card-body stack">
        <div>
          <p className="eyebrow" style={{ marginBottom: 8 }}>
            Start a demo from the shell
          </p>
          <CodeBlock code={curl} label={`POST ${origin}/api/demos`} />
        </div>
        <div>
          <p className="eyebrow" style={{ marginBottom: 8 }}>
            Poll it
          </p>
          <CodeBlock code={poll} label={`GET ${origin}/api/demos/:id`} />
        </div>
        <div>
          <p className="eyebrow" style={{ marginBottom: 8 }}>
            MCP server (streamable HTTP)
          </p>
          <CodeBlock code={mcp} label="Claude Desktop / any MCP client" />
          <p className="hint" style={{ marginTop: 8 }}>
            The MCP endpoint exposes the same tools as the REST surface — create_demo, wait_for_demo, list_graph_flows,
            create_article_from_flow, publish_article, and the rest — so an assistant can drive the whole pipeline.
          </p>
        </div>
        <div>
          <p className="eyebrow" style={{ marginBottom: 8 }}>
            Provision a workspace
          </p>
          <CodeBlock code={seed} label="First run" />
        </div>
      </div>
    </section>
  );
}

function DeploymentCard({
  health,
  loading,
  error,
  origin
}: {
  health: { version?: string; features?: string[]; status?: string } | null;
  loading: boolean;
  error: Error | null;
  origin: string;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Deployment</h2>
        <Pill tone={health ? 'good' : error ? 'warn' : 'neutral'} dot={!!health}>
          {loading ? 'Checking…' : health ? 'API online' : 'API unreachable'}
        </Pill>
      </div>
      <div className="card-body stack">
        {loading ? (
          <SkeletonRows rows={2} />
        ) : error ? (
          <ErrorPanel error={error} what="the deployment" />
        ) : (
          <KeyValue
            rows={[
              { key: 'API origin', value: <span className="mono">{origin}</span> },
              { key: 'Base path', value: <span className="mono">/api</span> },
              { key: 'Version', value: health?.version ? <span className="mono">{health.version}</span> : <span className="dim">not reported</span> },
              { key: 'Health', value: <span className="mono">GET {origin}/api/health</span> },
              {
                key: 'Features',
                value: health?.features?.length ? (
                  <span className="row wrap">
                    {health.features.map((feature) => (
                      <Pill key={feature} tone="channel">
                        {feature}
                      </Pill>
                    ))}
                  </span>
                ) : (
                  <span className="dim">not reported</span>
                )
              },
              { key: 'Auth header', value: <span className="mono">X-API-Key: rg_…</span> },
              { key: 'Alternate auth', value: <span className="mono">Authorization: Bearer rg_…</span> }
            ]}
          />
        )}
        <p className="note">
          Self-hosted: the dashboard, the API, the worker and the demo site all run from this repo. The API mounts this bundle at{' '}
          <code>/app</code> and the guide widget at <code>/g/guide.js</code>.
        </p>
      </div>
    </section>
  );
}
