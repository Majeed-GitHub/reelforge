import { useState } from 'react';
import type { FormEvent } from 'react';
import type { EnvironmentRow, SignInMode } from '@core';
import { api } from '../api.ts';
import type { LoginCode, VerifyResult } from '../api.ts';
import { formatDateTime, formatRelative, hostOf } from '../format.ts';
import { confirmAction, useLoader } from '../hooks.ts';
import { Privacy } from '../components/Privacy.tsx';
import { Banner, CodeBlock, CopyButton, EmptyState, ErrorPanel, Field, Pill, SkeletonRows } from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';

type EnvironmentView = EnvironmentRow & { hasSession?: boolean; hasCredentials?: boolean };

const SIGN_IN_LABEL: Record<SignInMode, string> = {
  none: 'No sign-in',
  password: 'Password account',
  session: 'Captured session'
};

export function EnvironmentsScreen() {
  const environments = useLoader(() => api.environments.list(), []);
  const rows = (environments.data ?? []) as EnvironmentView[];
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Environments</h1>
          <p className="page-sub">
            A saved product is where sessions, flows and the Product Graph live. Sign-in is captured, never a password stored in the
            browser: Reelforge keeps an encrypted Playwright storageState you attach once.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setShowCreate((value) => !value)}>
          {showCreate ? <Icon name="close" size={14} /> : <Icon name="plus" size={14} />}
          {showCreate ? 'Close' : 'New environment'}
        </button>
      </div>

      <div className="stack-lg">
        {showCreate ? <CreateEnvironment onCreated={() => { setShowCreate(false); environments.reload(); }} /> : null}

        {environments.loading ? (
          <div className="card">
            <SkeletonRows rows={4} />
          </div>
        ) : environments.error ? (
          <ErrorPanel error={environments.error} onRetry={environments.reload} what="environments" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="environments"
            title="No environments yet"
            body="Save a product once — its base URL and how you sign in. Every demo recorded against it joins the same Product Graph, so flows update instead of multiplying."
            action={
              <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
                <Icon name="plus" size={14} />
                Add the first environment
              </button>
            }
          />
        ) : (
          <div className="stack">
            {rows.map((environment) => (
              <EnvironmentCard key={environment.id} environment={environment} onChanged={environments.reload} />
            ))}
          </div>
        )}

        <section className="card card-pad stack">
          <h2 className="section-title">How sign-in works</h2>
          <div className="grid-2">
            <div className="stack-sm">
              <p className="note">
                <strong style={{ color: 'var(--text)' }}>Captured session (recommended).</strong> Generate a login code, run{' '}
                <code>npx reelforge session DIR-XXXX-XXXX-XXXX</code>, sign in once in the window that opens, and the CLI posts the
                captured Playwright <code>storageState</code> back to this API. The secret is AES-256-GCM encrypted at rest and is
                never readable through the API.
              </p>
              <p className="note">
                <strong style={{ color: 'var(--text)' }}>Password account.</strong> Credentials are stored encrypted and used only
                off-camera, before recording starts. A stored password is a liability; a captured session is not.
              </p>
            </div>
            <div className="stack-sm">
              <p className="note">
                <strong style={{ color: 'var(--text)' }}>Passkeys cannot be replayed.</strong> They are origin- and device-bound, so
                a passkey-gated product needs a password or a captured session for its test account.
              </p>
              <p className="note">
                Sessions expire. When one does, a run fails with{' '}
                <code>ENVIRONMENT_SESSION_EXPIRED</code> and the remediation points back here — verify, then attach a fresh
                session.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function CreateEnvironment({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [signInMode, setSignInMode] = useState<SignInMode>('session');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<EnvironmentRow | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!name.trim() || !baseUrl.trim()) {
      setError(new Error('A name and a base URL are both required.'));
      return;
    }
    setSubmitting(true);
    try {
      const environment = await api.environments.create({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        signInMode,
        ...(signInMode === 'password' && username.trim()
          ? { credentials: { username: username.trim(), password } }
          : {})
      });
      setCreated(environment);
      setName('');
      setBaseUrl('');
      setUsername('');
      setPassword('');
      onCreated();
    } catch (cause) {
      setError(cause);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">New environment</h2>
        <span className="hint">Name, base URL, sign-in mode</span>
      </div>
      <form className="card-body stack" onSubmit={submit} noValidate>
        <div className="grid-3">
          <Field label="Name" htmlFor="env-name" hint="What your team calls this product.">
            <input id="env-name" className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Northwind" />
          </Field>
          <Field label="Base URL" htmlFor="env-url" hint="Public HTTPS URL or a tunnel. No trailing path.">
            <input
              id="env-url"
              className="input mono"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="http://127.0.0.1:4402"
              spellCheck={false}
            />
          </Field>
          <Field label="Sign-in mode" htmlFor="env-mode" hint={SIGN_IN_LABEL[signInMode]}>
            <select
              id="env-mode"
              className="select"
              value={signInMode}
              onChange={(event) => setSignInMode(event.target.value as SignInMode)}
            >
              <option value="session">Captured session (recommended)</option>
              <option value="password">Password account</option>
              <option value="none">No sign-in / public site</option>
            </select>
          </Field>
        </div>

        {signInMode === 'password' ? (
          <div className="grid-2">
            <Field label="Test account email" htmlFor="env-user" hint="Used off-camera before recording.">
              <input
                id="env-user"
                className="input mono"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="ada@example.com"
                autoComplete="off"
              />
            </Field>
            <Field label="Password" htmlFor="env-pass" hint="Encrypted at rest, never returned by the API.">
              <input
                id="env-pass"
                className="input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </div>
        ) : null}

        {signInMode === 'session' ? (
          <p className="note">
            Create the environment, then generate a login code on its card and attach a captured session. Recording against an
            environment without a session will fail with a remediation that links back here.
          </p>
        ) : null}

        {error ? <ErrorPanel error={error} what="create the environment" /> : null}

        {created ? (
          <Banner tone="ok" title={`${created.name} saved`}>
            <p>
              {hostOf(created.base_url)} is now in your workspace. Generate a login code below to attach a session
              {created.sign_in_mode === 'password' ? ', or record straight away with the stored credentials.' : '.'}
            </p>
          </Banner>
        ) : null}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? <Icon name="refresh" size={14} className="spin" /> : <Icon name="plus" size={14} />}
            {submitting ? 'Saving…' : 'Save environment'}
          </button>
        </div>
      </form>
    </section>
  );
}

function EnvironmentCard({ environment, onChanged }: { environment: EnvironmentView; onChanged: () => void }) {
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<unknown>(null);

  const [codeBusy, setCodeBusy] = useState(false);
  const [code, setCode] = useState<LoginCode | null>(null);
  const [codeError, setCodeError] = useState<unknown>(null);

  const [showAttach, setShowAttach] = useState(false);
  const [attachText, setAttachText] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<unknown>(null);
  const [attachDone, setAttachDone] = useState<string | null>(null);

  const command = code ? `npx reelforge session ${code.code}` : '';

  async function verify() {
    setVerifying(true);
    setVerifyError(null);
    setVerifyResult(null);
    try {
      setVerifyResult(await api.environments.verify(environment.id));
    } catch (cause) {
      setVerifyError(cause);
    } finally {
      setVerifying(false);
    }
  }

  async function requestLoginCode() {
    setCodeBusy(true);
    setCodeError(null);
    try {
      setCode(await api.environments.loginCode(environment.id));
    } catch (cause) {
      setCodeError(cause);
    } finally {
      setCodeBusy(false);
    }
  }

  async function attachSession() {
    setAttachError(null);
    setAttachDone(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(attachText);
    } catch {
      setAttachError(new Error('That is not valid JSON. Paste the storageState object the capture script printed.'));
      return;
    }
    setAttaching(true);
    try {
      await api.environments.attachSession(environment.id, parsed);
      setAttachDone('Session attached. Recording can use the stored sign-in now.');
      setAttachText('');
      setShowAttach(false);
      onChanged();
    } catch (cause) {
      setAttachError(cause);
    } finally {
      setAttaching(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="row wrap" style={{ marginBottom: 4 }}>
            <Pill tone="neutral">{SIGN_IN_LABEL[environment.sign_in_mode] ?? environment.sign_in_mode}</Pill>
            {environment.hasSession ? <Pill tone="good">Session attached</Pill> : null}
            {environment.hasCredentials ? <Pill tone="channel">Credentials stored</Pill> : null}
            {!environment.hasSession && !environment.hasCredentials && environment.sign_in_mode !== 'none' ? (
              <Pill tone="warn">No sign-in attached</Pill>
            ) : null}
          </div>
          <h2 className="section-title" style={{ fontSize: 16 }}>
            <Privacy label="environment name">{environment.name}</Privacy>
          </h2>
          <p className="hint mono" style={{ marginTop: 2 }}>
            <Privacy label="environment base URL">{environment.base_url}</Privacy>
          </p>
        </div>
        <div className="row" style={{ flexShrink: 0 }}>
          <button type="button" className="btn btn-sm" onClick={verify} disabled={verifying}>
            {verifying ? <Icon name="refresh" size={13} className="spin" /> : <Icon name="check" size={13} />}
            {verifying ? 'Verifying…' : 'Verify'}
          </button>
          <button type="button" className="btn btn-sm" onClick={requestLoginCode} disabled={codeBusy}>
            {codeBusy ? <Icon name="refresh" size={13} className="spin" /> : <Icon name="key" size={13} />}
            Login code
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAttach((value) => !value)}>
            <Icon name="upload" size={13} />
            Attach session
          </button>
        </div>
      </div>

      <div className="card-body stack">
        {verifyError ? <ErrorPanel error={verifyError} what="verify this environment" /> : null}
        {verifyResult ? (
          <Banner
            tone={verifyResult.ok === false ? 'warn' : 'ok'}
            title={verifyResult.ok === false ? 'Verification failed' : 'Sign-in verified'}
          >
            <p>
              Checked {verifyResult.checkedAt ? formatDateTime(verifyResult.checkedAt) : 'just now'}
              {verifyResult.signInMode ? ` · ${SIGN_IN_LABEL[verifyResult.signInMode] ?? verifyResult.signInMode}` : ''}
            </p>
            {verifyResult.reason ? <p style={{ marginTop: 6 }}>{verifyResult.reason}</p> : null}
            {verifyResult.ok === false ? (
              <p style={{ marginTop: 6 }}>Attach a fresh session with a login code below, then verify again.</p>
            ) : null}
          </Banner>
        ) : null}

        {codeError ? <ErrorPanel error={codeError} what="create a login code" /> : null}

        {code ? (
          <div className="card card-pad stack-sm" style={{ background: 'var(--bg-2)' }}>
            <div className="row-between">
              <span className="eyebrow">One-time login code</span>
              <span className="hint">
                {code.expiresAt ? `expires ${formatRelative(code.expiresAt)}` : 'expires in 30 minutes'} · single use
              </span>
            </div>
            <div className="row wrap">
              <span className="mono" style={{ fontSize: 17, letterSpacing: '0.08em' }}>
                {code.code}
              </span>
              <CopyButton text={code.code} label="Copy code" />
            </div>
            <p className="hint">Run this on the machine that can reach the product, and sign in once in the window that opens:</p>
            <CodeBlock code={command} label="CLI" />
            <p className="hint">
              The CLI captures a Playwright storageState (cookies + IndexedDB) and posts it to{' '}
              <code>POST /api/environments/{environment.id}/session</code>. Codes are single-use and expire in 30 minutes.
            </p>
          </div>
        ) : null}

        {attachDone ? (
          <Banner tone="ok" title="Session attached">
            <p>{attachDone}</p>
          </Banner>
        ) : null}

        {showAttach ? (
          <div className="stack">
            <Field
              label="Paste storageState JSON"
              htmlFor={`attach-${environment.id}`}
              hint="The object {cookies, origins} printed by the capture script. Stored encrypted; never returned by the API."
            >
              <textarea
                id={`attach-${environment.id}`}
                className="textarea mono"
                rows={6}
                value={attachText}
                onChange={(event) => setAttachText(event.target.value)}
                placeholder='{"cookies":[…],"origins":[…]}'
                spellCheck={false}
              />
            </Field>
            {attachError ? <ErrorPanel error={attachError} what="attach the session" /> : null}
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={attachSession} disabled={attaching || !attachText.trim()}>
                {attaching ? <Icon name="refresh" size={14} className="spin" /> : <Icon name="upload" size={14} />}
                {attaching ? 'Attaching…' : 'Attach session'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setShowAttach(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <div className="row-between" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <span className="hint">
            Saved {formatRelative(environment.created_at)} · <Privacy label="environment host">{hostOf(environment.base_url)}</Privacy>
          </span>
          <span className="hint mono" style={{ fontSize: 11 }}>
            {environment.id}
          </span>
        </div>
      </div>
    </section>
  );
}
