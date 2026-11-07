import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import type { EnvironmentRow, PresetRow, SignInMode } from '@core';
import { api, isApiError } from '../api.ts';
import type { CreateDemoBody } from '../api.ts';
import { hostOf, truncate } from '../format.ts';
import { useLoader } from '../hooks.ts';
import { href, navigate } from '../router.ts';
import { Banner, CheckRow, ErrorPanel, Field, RangeField } from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';

const LANGUAGES = [
  { value: 'en', label: 'English (en)' },
  { value: 'es', label: 'Spanish (es)' },
  { value: 'de', label: 'German (de)' },
  { value: 'fr', label: 'French (fr)' },
  { value: 'hi', label: 'Hindi (hi)' },
  { value: 'ja', label: 'Japanese (ja)' },
  { value: 'pt', label: 'Portuguese (pt)' },
  { value: 'it', label: 'Italian (it)' }
];

const EXAMPLES = [
  'Create a project, then invite a teammate.',
  'Walk through upgrading to the Team plan from billing.',
  'Sign in, open the team page and show how to add a member.'
];

const SIGN_IN_LABEL: Record<SignInMode, string> = {
  none: 'No sign-in',
  password: 'Password account',
  session: 'Captured session'
};

export function NewDemoScreen() {
  const environments = useLoader(
    () => api.environments.list().catch((): EnvironmentRow[] => []),
    []
  );
  const presets = useLoader(
    () => api.presets.list().catch((): PresetRow[] => []),
    []
  );

  const [mode, setMode] = useState<'url' | 'environment'>('url');
  const [url, setUrl] = useState('http://127.0.0.1:4402');
  const [environmentId, setEnvironmentId] = useState('');
  const [path, setPath] = useState('');
  const [instruction, setInstruction] = useState('');
  const [language, setLanguage] = useState('en');
  const [fps, setFps] = useState(30);
  const [maxSteps, setMaxSteps] = useState(40);
  const [watermark, setWatermark] = useState(true);
  const [zoom, setZoom] = useState(1.6);
  const [presetId, setPresetId] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [confirmDestructive, setConfirmDestructive] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [needsAttestation, setNeedsAttestation] = useState(false);
  const [attesting, setAttesting] = useState(false);
  const [attestedHost, setAttestedHost] = useState<string | null>(null);

  const environmentList = environments.data ?? [];
  useEffect(() => {
    if (!environmentId && environmentList.length > 0) setEnvironmentId(environmentList[0].id);
  }, [environmentList, environmentId]);

  const selectedEnvironment = environmentList.find((environment) => environment.id === environmentId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    setError(null);
    setNeedsAttestation(false);

    const sentence = instruction.replace(/\s+/g, ' ').trim();
    if (sentence.length < 3) {
      setLocalError('Describe the walkthrough in one sentence — at least a few words.');
      return;
    }
    if (mode === 'url' && !url.trim()) {
      setLocalError('Enter the product URL to record.');
      return;
    }
    if (mode === 'environment' && !environmentId) {
      setLocalError('Choose a saved environment, or switch back to a URL.');
      return;
    }

    const options: NonNullable<CreateDemoBody['options']> = {
      language,
      fps,
      maxSteps,
      watermark,
      zoom
    };
    if (presetId) options.presetId = presetId;

    const body: CreateDemoBody = {
      instruction: sentence,
      authorized,
      confirmDestructive,
      options
    };
    if (mode === 'url') {
      body.target = { type: 'url', url: url.trim() };
    } else {
      body.environmentId = environmentId;
      if (path.trim()) body.path = path.trim();
    }

    setSubmitting(true);
    try {
      const created = await api.demos.create(body);
      if (!created.id) throw new Error('The API accepted the request but returned no demo id.');
      navigate(href.demo(created.id));
    } catch (cause) {
      setError(cause);
      if (isApiError(cause) && cause.code === 'DOMAIN_AUTHORIZATION_REQUIRED') setNeedsAttestation(true);
      setSubmitting(false);
    }
  }

  async function attestDomain() {
    setAttesting(true);
    try {
      await api.domains.attest(hostOf(url));
      setAttestedHost(hostOf(url));
      setAuthorized(true);
      setNeedsAttestation(false);
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setAttesting(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <a className="row hint" href={href.demos()} style={{ marginBottom: 8, gap: 6, color: 'var(--text-3)' }}>
            <Icon name="arrow-left" size={13} />
            All demos
          </a>
          <h1 className="page-title">New demo</h1>
          <p className="page-sub">
            One URL and one sentence. Reelforge plans each action, drives a real Chromium window, records the run and turns it into
            the video, article, training doc and in-app guide.
          </p>
        </div>
      </div>

      <form onSubmit={submit} noValidate>
        <div className="detail-grid">
          <div className="stack-lg">
            {/* ---------------------------------------------------- target */}
            <section className="card">
              <div className="card-head">
                <h2 className="section-title">Target</h2>
                <span className="hint">Where the browser goes</span>
              </div>
              <div className="card-body stack">
                <div className="seg" role="group" aria-label="Choose target type">
                  <button
                    type="button"
                    className="seg-btn"
                    aria-pressed={mode === 'url'}
                    onClick={() => setMode('url')}
                  >
                    Product URL
                  </button>
                  <button
                    type="button"
                    className="seg-btn"
                    aria-pressed={mode === 'environment'}
                    onClick={() => setMode('environment')}
                  >
                    Saved environment
                  </button>
                </div>

                {mode === 'url' ? (
                  <Field
                    label="Product URL"
                    htmlFor="target-url"
                    hint="Public HTTPS URL, a tunnel, or http://127.0.0.1:4402 for the bundled demo site. Reelforge refuses to record a domain you have not confirmed you may demo."
                  >
                    <input
                      id="target-url"
                      className="input mono"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder="https://app.example.com"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </Field>
                ) : (
                  <Field
                    label="Environment"
                    htmlFor="target-env"
                    hint={
                      environmentList.length === 0
                        ? 'No saved environments yet — create one on the Environments screen, or record the URL directly.'
                        : 'A saved product carries its sign-in and its Product Graph, so this run updates existing flows instead of duplicating them.'
                    }
                  >
                    <select
                      id="target-env"
                      className="select"
                      value={environmentId}
                      onChange={(event) => setEnvironmentId(event.target.value)}
                      disabled={environmentList.length === 0}
                    >
                      {environmentList.length === 0 ? <option value="">No environments saved</option> : null}
                      {environmentList.map((environment) => (
                        <option key={environment.id} value={environment.id}>
                          {environment.name} · {hostOf(environment.base_url)} · {SIGN_IN_LABEL[environment.sign_in_mode] ?? environment.sign_in_mode}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}

                {mode === 'environment' ? (
                  <div className="grid-2">
                    <Field label="Start path" optional htmlFor="target-path" hint="Resolved against the environment's base URL.">
                      <input
                        id="target-path"
                        className="input mono"
                        value={path}
                        onChange={(event) => setPath(event.target.value)}
                        placeholder="/app"
                        spellCheck={false}
                      />
                    </Field>
                    <div className="field">
                      <span className="label">Resolved start</span>
                      <span className="mono hint" style={{ paddingTop: 8 }}>
                        {selectedEnvironment ? `${selectedEnvironment.base_url.replace(/\/$/, '')}${path || ''}` : 'Choose an environment'}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            {/* ------------------------------------------------- instruction */}
            <section className="card">
              <div className="card-head">
                <h2 className="section-title">Instruction</h2>
                <span className="hint">Plain language, 3–2000 characters</span>
              </div>
              <div className="card-body stack">
                <Field
                  label="What should the demo show?"
                  htmlFor="instruction"
                  hint="Name the outcome, not the clicks. The planner works out the steps and writes the narration from what it actually does."
                >
                  <textarea
                    id="instruction"
                    className="textarea"
                    rows={4}
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value)}
                    placeholder="Create a project, then invite a teammate."
                    maxLength={2000}
                  />
                </Field>
                <div className="row-between">
                  <div className="row wrap">
                    {EXAMPLES.map((example) => (
                      <button
                        key={example}
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setInstruction(example)}
                      >
                        {truncate(example, 46)}
                      </button>
                    ))}
                  </div>
                  <span className="hint num">{instruction.trim().length} / 2000</span>
                </div>
              </div>
            </section>

            {/* ---------------------------------------------------- options */}
            <section className="card">
              <div className="card-head">
                <h2 className="section-title">Advanced options</h2>
                <span className="hint">Defaults are production-safe</span>
              </div>
              <div className="card-body stack">
                <div className="grid-3">
                  <Field label="Narration language" htmlFor="opt-language" hint="Voice and captions.">
                    <select id="opt-language" className="select" value={language} onChange={(event) => setLanguage(event.target.value)}>
                      {LANGUAGES.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Capture fps" htmlFor="opt-fps" hint="1–60. 30 is smooth without bloating the render.">
                    <input
                      id="opt-fps"
                      className="input num"
                      type="number"
                      min={1}
                      max={60}
                      value={fps}
                      onChange={(event) => setFps(clamp(Number(event.target.value), 1, 60, 30))}
                    />
                  </Field>
                  <Field label="Max steps" htmlFor="opt-steps" hint="1–60. A budget, so a run ends instead of wandering.">
                    <input
                      id="opt-steps"
                      className="input num"
                      type="number"
                      min={1}
                      max={60}
                      value={maxSteps}
                      onChange={(event) => setMaxSteps(clamp(Number(event.target.value), 1, 60, 40))}
                    />
                  </Field>
                </div>

                <div className="grid-2">
                  <RangeField
                    label="Auto-zoom"
                    value={zoom}
                    min={1}
                    max={2.5}
                    step={0.1}
                    onChange={setZoom}
                    format={(value) => `${value.toFixed(1)}×`}
                    hint="1.0× is a static full-frame shot; 1.6× follows the action. Cuts are clamped inside the viewport."
                  />
                  <Field label="Recording preset" optional htmlFor="opt-preset" hint={presets.data?.length ? 'A preset from Settings.' : 'No presets returned by the API — using defaults.'}>
                    <select
                      id="opt-preset"
                      className="select"
                      value={presetId}
                      onChange={(event) => setPresetId(event.target.value)}
                      disabled={!presets.data || presets.data.length === 0}
                    >
                      <option value="">Default</option>
                      {(presets.data ?? []).map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                          {preset.is_default ? ' · default' : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <div className="grid-2">
                  <CheckRow
                    checked={watermark}
                    onChange={setWatermark}
                    title="Burn the Reelforge wordmark"
                    hint="Bottom-right, subtle. Turn off for a clean master."
                  />
                  <CheckRow
                    checked={confirmDestructive}
                    onChange={setConfirmDestructive}
                    title="Allow destructive steps"
                    hint="Delete, remove, revoke. Off means the planner stops before them."
                  />
                </div>

                <CheckRow
                  checked={authorized}
                  onChange={setAuthorized}
                  title="I own this product or have permission to record it"
                  hint="Required once per new domain. This is the DOMAIN_AUTHORIZATION_REQUIRED gate, not a legal disclaimer."
                />
              </div>
            </section>

            {/* ---------------------------------------------------- submit */}
            <div className="stack">
              {localError ? <Banner tone="error" title="Check the form">{localError}</Banner> : null}

              {error ? <ErrorPanel error={error} what="start the demo" /> : null}

              {needsAttestation ? (
                <Banner
                  tone="warn"
                  title="This domain has not been attested yet"
                  actions={
                    <>
                      <button type="button" className="btn btn-sm" onClick={attestDomain} disabled={attesting}>
                        {attesting ? <Icon name="refresh" size={13} className="spin" /> : <Icon name="check" size={13} />}
                        {attesting ? 'Attesting…' : `Attest ${hostOf(url)}`}
                      </button>
                    </>
                  }
                >
                  <p>
                    Recording a new domain needs a one-time confirmation. Attest it here and submit again — or tick the permission
                    checkbox above.
                  </p>
                </Banner>
              ) : null}

              {attestedHost ? (
                <Banner tone="ok" title={`${attestedHost} attested`}>
                  <p>Submit again and the run will start.</p>
                </Banner>
              ) : null}

              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? <Icon name="refresh" size={14} className="spin" /> : <Icon name="play" size={14} />}
                  {submitting ? 'Starting…' : 'Record demo'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => navigate(href.demos())} disabled={submitting}>
                  Cancel
                </button>
                <span className="hint" style={{ marginLeft: 'auto' }}>
                  Returns immediately with a queued demo.
                </span>
              </div>
            </div>
          </div>

          {/* ------------------------------------------------------ aside */}
          <aside className="stack">
            <section className="card card-pad stack-sm">
              <h2 className="section-title">One run, four outputs</h2>
              <OutputRow icon="film" title="Narrated MP4" body="Recorded browser session, auto-zoom, captions and voice." />
              <OutputRow icon="articles" title="Help-centre article" body="Step-by-step with screenshots, published-ready Markdown." />
              <OutputRow icon="articles" title="Internal training doc" body="The same flow written for your team, not your customers." />
              <OutputRow icon="guides" title="In-app guide" body="A spotlight walkthrough you embed with one script tag." />
            </section>

            <section className="card card-pad stack-sm">
              <h2 className="section-title">Pipeline</h2>
              <ol className="list-reset">
                {[
                  'Validate target, credits and domain attestation',
                  'Drive Chromium: observe → plan → act → screenshot',
                  'Narrate, caption, auto-zoom and render the MP4',
                  'Upsert flows and screens into the Product Graph',
                  'Write the article and draft the embeddable guide'
                ].map((line, index) => (
                  <li key={line} className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
                    <span className="step-idx" style={{ textAlign: 'left' }}>
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="hint">{line}</span>
                  </li>
                ))}
              </ol>
            </section>

            <section className="card card-pad stack-sm">
              <h2 className="section-title">Limits</h2>
              <p className="note">
                Concurrency is capped per plan, so a fourth run is queued rather than dropped. Credits are modelled per minute of
                output. Nothing is billed by default while self-hosting.
              </p>
            </section>
          </aside>
        </div>
      </form>
    </div>
  );
}

function OutputRow({ icon, title, body }: { icon: 'film' | 'articles' | 'guides'; title: string; body: string }) {
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
      <span className="empty-mark" style={{ width: 26, height: 26, borderRadius: 7 }}>
        <Icon name={icon} size={13} />
      </span>
      <span>
        <span style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>{title}</span>
        <span className="hint">{body}</span>
      </span>
    </div>
  );
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}
