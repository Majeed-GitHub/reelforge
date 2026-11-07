import { useEffect, useMemo, useState } from 'react';
import { apiV2 } from '../api.ts';
import type { LlmProviderState, ProvidersState, ProviderTestResult } from '../api.ts';
import { Banner, CodeBlock, ErrorPanel, Field, Pill, SkeletonRows } from '../components/ui.tsx';


/**
 * Bring-your-own-key setup.
 *
 * The planner is one OpenAI-compatible chat call, so the same screen configures
 * GMI Cloud, OpenAI, OpenRouter, a local Ollama, or any other gateway. Keys are
 * posted once and never read back â€” the API returns a masked hint only.
 */
export function ProviderSettingsCard() {
  const [state, setState] = useState<ProvidersState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      setState(await apiV2.providers.get());
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="section-title">Model provider</h2>
          <p className="muted">
            The planner decides which button to click. Point it at your own model â€” any OpenAI-compatible endpoint works, and
            nothing is sent anywhere until you pick one.
          </p>
        </div>
        {state ? <ProviderStatePill state={state} /> : null}
      </div>

      {loading && !state ? <SkeletonRows rows={3} /> : null}
      {error ? <ErrorPanel error={error} onRetry={refresh} what="the provider settings" /> : null}

      {state ? (
        <div className="stack">
          <ActiveProviderLine state={state} />
          <div className="provider-grid">
            {state.llm.providers.map((provider) => (
              <ProviderTile
                key={provider.id}
                provider={provider}
                selected={provider.id === state.llm.active.providerId}
                onSaved={refresh}
              />
            ))}
          </div>
        </div>
      ) : null}
      <NarrationCard state={state} />
    </section>
  );
}

function ProviderStatePill({ state }: { state: ProvidersState }) {
  const source = state.llm.active.source;
  if (source === 'env') return <Pill tone="good" dot>set by environment</Pill>;
  if (source === 'workspace') return <Pill tone="good" dot>configured</Pill>;
  return <Pill tone="warn" dot>offline planner</Pill>;
}

function ActiveProviderLine({ state }: { state: ProvidersState }) {
  const { active } = state.llm;
  if (active.source === 'none') {
    return (
      <Banner tone="info" title="Running fully local">
        No model is configured, so Reelforge uses the offline scripted planner â€” it understands sign-in, navigation, create,
        invite and upgrade flows and narrates them. Add a key below for open-ended instructions.
      </Banner>
    );
  }
  const label = state.llm.providers.find((p) => p.id === active.providerId)?.label ?? active.providerId;
  return (
    <div className="row row-between">
      <div>
        <div className="eyebrow">in use</div>
        <div>
          <strong>{label}</strong>
          {active.model ? <span className="muted"> Â· {active.model}</span> : null}
          {active.source === 'env' ? <span className="muted"> Â· from environment variables</span> : null}
        </div>
      </div>
      {active.baseUrl ? <span className="mono dim truncate">{active.baseUrl}</span> : null}
    </div>
  );
}

function ProviderTile({
  provider,
  selected,
  onSaved
}: {
  provider: LlmProviderState;
  selected: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(selected);
  useEffect(() => {
    if (selected) setOpen(true);
  }, [selected]);

  return (
    <div className={`provider-tile${selected ? ' selected' : ''}`}>
      <button type="button" className="provider-tile-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="provider-tile-name">{provider.label}</span>
        <span className="provider-tile-meta">
          {provider.configured ? (
            <Pill tone="good" dot>
              {provider.source === 'env' ? 'env' : 'ready'}
            </Pill>
          ) : provider.requiresKey ? (
            <Pill tone="neutral">needs key</Pill>
          ) : (
            <Pill tone="neutral">local</Pill>
          )}

        </span>
      </button>

      {open ? (
        <ProviderForm provider={provider} selected={selected} onSaved={onSaved} />
      ) : provider.note ? (
        <p className="hint">{provider.note}</p>
      ) : null}
    </div>
  );
}

function ProviderForm({
  provider,
  selected,
  onSaved
}: {
  provider: LlmProviderState;
  selected: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(provider.model ?? provider.defaultModel ?? '');
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<'save' | 'models' | 'test' | 'clear' | null>(null);
  const [test, setTest] = useState<ProviderTestResult | null>(null);
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    setModel(provider.model ?? provider.defaultModel ?? '');
    setBaseUrl(provider.baseUrl ?? '');
    setApiKey('');
    setTest(null);
    setNotice(null);
  }, [provider.id, provider.model, provider.baseUrl, provider.defaultModel]);

  const needsBaseUrl = provider.baseUrl === '';

  async function run(kind: 'save' | 'models' | 'test' | 'clear') {
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === 'models') {
        const list = await apiV2.providers.models(provider.id, baseUrl || undefined);
        setModels(list);
        setNotice(
          list.length
            ? { tone: 'good', text: `${list.length} model(s) available` }
            : { tone: 'bad', text: 'No models returned â€” check the key or that the local server is running.' }
        );
        if (list.length && !model) setModel(list[0]);
      } else if (kind === 'test') {
        const result = await apiV2.providers.test({
          providerId: provider.id,
          apiKey: apiKey || undefined,
          model: model || undefined,
          baseUrl: baseUrl || undefined
        });
        setTest(result);
        setNotice(
          result.ok
            ? { tone: 'good', text: `Connected to ${result.model ?? (model || provider.label)} in ${result.latencyMs ?? '?'} ms` }
            : { tone: 'bad', text: result.error ?? 'Connection failed.' }
        );
      } else if (kind === 'save') {
        await apiV2.providers.save({
          llm: {
            providerId: provider.id,
            apiKey: apiKey || undefined,
            model: model || undefined,
            baseUrl: baseUrl || undefined
          }
        });
        setApiKey('');
        setNotice({ tone: 'good', text: 'Saved for this workspace.' });
        await onSaved();
      } else if (kind === 'clear') {
        await apiV2.providers.clear();
        setNotice({ tone: 'good', text: 'Workspace override cleared.' });
        await onSaved();
      }
    } catch (error) {
      setNotice({ tone: 'bad', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack-sm provider-form">
      {provider.note ? <p className="hint">{provider.note}</p> : null}

      {needsBaseUrl ? (
        <Field label="Base URL" htmlFor={`${provider.id}-base`} hint="Any endpoint that speaks /chat/completions.">
          <input
            id={`${provider.id}-base`}
            className="input"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://your-gateway.example.com/v1"
          />
        </Field>
      ) : (
        <div className="hint mono">{provider.baseUrl}</div>
      )}

      {provider.requiresKey ? (
        <Field
          label="API key"
          htmlFor={`${provider.id}-key`}
          hint={
            provider.keyHint
              ? `Stored key: ${provider.keyHint} â€” leave blank to keep it.`
              : 'Stored encrypted (AES-256-GCM) and never returned by the API.'
          }
        >
          <input
            id={`${provider.id}-key`}
            className="input"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={provider.keyHint ?? 'paste your key'}
          />
        </Field>
      ) : (
        <p className="hint">No key needed â€” this one runs on your machine.</p>
      )}

      <Field label="Model" htmlFor={`${provider.id}-model`} optional hint="Leave blank to use the provider's first available model.">
        <div className="row">
          <input
            id={`${provider.id}-model`}
            className="input grow"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={provider.defaultModel || 'model id'}
            list={`${provider.id}-models`}
          />
          <datalist id={`${provider.id}-models`}>
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => run('models')} disabled={busy !== null}>
            {busy === 'models' ? 'Fetchingâ€¦' : 'Fetch models'}
          </button>
        </div>
      </Field>

      <div className="row wrap">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => run('save')} disabled={busy !== null}>
          {busy === 'save' ? 'Savingâ€¦' : selected ? 'Save changes' : 'Use this provider'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => run('test')} disabled={busy !== null}>
          {busy === 'test' ? 'Testingâ€¦' : 'Test connection'}
        </button>
        {provider.source === 'workspace' ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => run('clear')} disabled={busy !== null}>
            Clear
          </button>
        ) : null}
      </div>

      {notice ? (
        <p className={notice.tone === 'good' ? 'hint good' : 'hint bad'} role="status">
          {notice.text}
        </p>
      ) : null}
      {test?.ok && test.latencyMs !== undefined ? <p className="hint mono">latency {test.latencyMs} ms</p> : null}
    </div>
  );
}

/** Narration: same screen, different catalog. */
export function NarrationCard({ state }: { state: ProvidersState | null }) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const active = state?.tts.active;

  const options = useMemo(() => state?.tts.providers ?? [], [state]);
  const [providerId, setProviderId] = useState(active?.providerId ?? 'sapi');
  const [voice, setVoice] = useState(active?.voice ?? '');

  useEffect(() => {
    if (active?.providerId) setProviderId(active.providerId);
    if (active?.voice) setVoice(active.voice);
  }, [active?.providerId, active?.voice]);

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      await apiV2.providers.save({ tts: { providerId, voice: voice || undefined } });
      setNotice('Saved. New demos will narrate with this voice.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  if (!state) return null;

  return (
    <section className="card card-pad">
      <h2 className="section-title">Narration</h2>
      <p className="muted">
        Voiceover is generated per step and mixed into the render. Offline options need no keys; cloud voices sound better.
      </p>
      <div className="stack-sm">
        <Field label="Voice provider" htmlFor="tts-provider">
          <select id="tts-provider" className="input" value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
                {option.offline ? ' Â· offline' : ''}
                {option.requiresKey ? ' Â· key' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Voice"
          htmlFor="tts-voice"
          optional
          hint={options.find((o) => o.id === providerId)?.note ?? 'Leave blank for the provider default.'}
        >
          <input
            id="tts-voice"
            className="input"
            value={voice}
            onChange={(event) => setVoice(event.target.value)}
            placeholder="e.g. Microsoft Zira Desktop, alloy, en-US-AriaNeural"
          />
        </Field>
        <div className="row">
          <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? 'Savingâ€¦' : 'Save narration settings'}
          </button>
          {notice ? <span className="hint">{notice}</span> : null}
        </div>
      </div>
    </section>
  );
}

/** The About panel: what this is, the licence, and how it was built. */
export function AboutCard({ version }: { version?: string }) {
  return (
    <section className="card card-pad">
      <h2 className="section-title">About</h2>
      <p className="muted">
        Reelforge is an open-source, self-hosted alternative to commercial product-demo agents. Give it a URL and one sentence: it
        drives your product in a real browser and publishes a narrated video, help article and in-app guide from one Product
        Graph. Bring your own model key, or run it fully local.
      </p>
      <div className="row wrap">
        <Pill tone="neutral">MIT</Pill>
        <Pill tone="neutral">self-hosted</Pill>
        {version ? <Pill tone="neutral">v{version}</Pill> : null}
      </div>
      <p className="hint">
        Built with the DeepSeek Harness, using the GMI Cloud API. Source and issues:{' '}
        <a className="btn-link" href="https://github.com/YOUR_GITHUB_USER/reelforge" target="_blank" rel="noreferrer">
          github.com/YOUR_GITHUB_USER/reelforge
        </a>
      </p>
      <CodeBlock
        label="Run it locally"
        code={`npm install\nnpx playwright install chromium\nnpm run seed\nnpm run dev`}
      />
    </section>
  );
}
