import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, clearApiKey, isApiError, isNetworkError, setApiKey } from '../api.ts';
import type { HealthState } from '../components/TopBar.tsx';
import { BrandMark } from '../components/icons.tsx';
import { Banner, CodeBlock, Field } from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';

/**
 * First-run panel. Shown only when this browser has no API key *and* the user
 * has not explicitly continued without one — the dashboard is a view over the
 * API, so without a key there is nothing honest to render.
 */
export function OnboardingScreen({
  health,
  onConnect,
  onSkip
}: {
  health: HealthState;
  onConnect: (key: string) => void;
  onSkip: () => void;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [canContinueAnyway, setCanContinueAnyway] = useState(false);

  async function connect(event: FormEvent) {
    event.preventDefault();
    const candidate = key.trim();
    setError(null);
    setCanContinueAnyway(false);
    if (!candidate) {
      setError(new Error('Paste the key that npm run seed printed.'));
      return;
    }
    setBusy(true);
    setApiKey(candidate);
    try {
      await api.demos.list();
      onConnect(candidate);
    } catch (cause) {
      if (isNetworkError(cause)) {
        setError(cause);
        setCanContinueAnyway(true);
      } else {
        clearApiKey();
        setError(cause);
      }
    } finally {
      setBusy(false);
    }
  }

  const unauthorized = isApiError(error) && (error.status === 401 || error.code === 'UNAUTHORIZED');
  const network = isNetworkError(error);

  return (
    <div className="onboard">
      <div className="onboard-card">
        <div className="row" style={{ gap: 10 }}>
          <BrandMark size={30} />
          <div>
            <div className="brand-name" style={{ fontSize: 16 }}>
              Reelforge
            </div>
            <div className="brand-tag">Self-hosted Director</div>
          </div>
        </div>

        <div>
          <h1 className="onboard-title">Connect this dashboard to your API</h1>
          <p className="onboard-sub" style={{ marginTop: 8 }}>
            One URL and one sentence in, a narrated demo video, a help article, a training doc and an in-app guide out — all views of
            one Product Graph. This browser needs a workspace key to read it.
          </p>
        </div>

        <div className="stack" style={{ gap: 14 }}>
          <div className="onboard-step">
            <span className="onboard-step-n">1</span>
            <div>
              <div style={{ fontWeight: 600 }}>Start the API</div>
              <p className="hint" style={{ marginTop: 2 }}>
                It listens on <code>http://127.0.0.1:4400</code> and serves this dashboard at <code>/app</code>.
              </p>
            </div>
          </div>
          <div className="onboard-step">
            <span className="onboard-step-n">2</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Provision a workspace key</div>
              <p className="hint" style={{ marginTop: 2 }}>
                The seed script prints the key once. Copy it before closing the terminal.
              </p>
              <div style={{ marginTop: 10 }}>
                <CodeBlock code={'npm run api     # http://127.0.0.1:4400\nnpm run seed    # prints rg_… once'} label="Repo root" />
              </div>
            </div>
          </div>
          <div className="onboard-step">
            <span className="onboard-step-n">3</span>
            <div>
              <div style={{ fontWeight: 600 }}>Paste it below</div>
              <p className="hint" style={{ marginTop: 2 }}>
                Stored in <code>localStorage</code> for this origin only, sent as <code>X-API-Key</code>.
              </p>
            </div>
          </div>
        </div>

        {health.status === 'offline' ? (
          <Banner tone="warn" title="The API is not answering yet">
            <p>
              Nothing is listening on this origin's <code>/api</code> proxy. Start it with <code>npm run api</code>, then paste the
              key.
            </p>
          </Banner>
        ) : null}

        <form className="stack-sm" onSubmit={connect} noValidate>
          <Field label="API key" htmlFor="onboard-key" hint="Looks like rg_9f3c2a…">
            <input
              id="onboard-key"
              className="input mono"
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="rg_…"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </Field>

          {unauthorized ? (
            <Banner tone="error" title="That key was rejected">
              <p>
                The API answered <code>401 UNAUTHORIZED</code>. Check you pasted the whole key, or re-run <code>npm run seed</code> and
                copy the fresh one.
              </p>
            </Banner>
          ) : error && !network ? (
            <Banner tone="error" title="Could not connect">
              <p>{error instanceof Error ? error.message : String(error)}</p>
            </Banner>
          ) : null}

          {network ? (
            <Banner tone="warn" title="Key saved, but the API is unreachable">
              <p>
                The key was stored in this browser. Start the API with <code>npm run api</code> and continue — every screen show a
                clear error state until it answers.
              </p>
            </Banner>
          ) : null}

          <div className="row" style={{ paddingTop: 4 }}>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <Icon name="refresh" size={14} className="spin" /> : <Icon name="key" size={14} />}
              {busy ? 'Checking key…' : 'Connect'}
            </button>
            {canContinueAnyway ? (
              <button type="button" className="btn btn-ghost" onClick={() => onConnect(key.trim())}>
                Continue anyway
              </button>
            ) : null}
          </div>
        </form>

        <div className="onboard-foot">
          <span className="hint">A key is scoped to one workspace.</span>
          <button type="button" className="btn-link" onClick={onSkip}>
            Continue without a key
          </button>
        </div>
      </div>
    </div>
  );
}
