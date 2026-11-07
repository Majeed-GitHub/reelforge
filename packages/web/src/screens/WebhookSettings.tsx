import { useEffect, useState } from 'react';
import { apiV2 } from '../api.ts';
import type { WebhookState } from '../api.ts';
import { CodeBlock, ErrorPanel, Field, SkeletonRows } from '../components/ui.tsx';
import { formatDateTime } from '../format.ts';

/**
 * Webhook configuration. One URL — a generic endpoint or a Slack incoming
 * webhook — plus an optional signing secret so the receiver can prove the call
 * came from this instance.
 */
export function WebhookSettingsCard() {
  const [state, setState] = useState<WebhookState | null>(null);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const next = await apiV2.webhooks.get();
      setState(next);
      setUrl(next.url ?? '');
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

  async function save() {
    setBusy('save');
    setNotice(null);
    try {
      const next = await apiV2.webhooks.save({ url: url.trim(), secret: secret.trim() || null });
      setState(next);
      setSecret('');
      setNotice({ tone: 'good', text: 'Webhook saved. The next finished demo will call it.' });
    } catch (cause) {
      setNotice({ tone: 'bad', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy('test');
    setNotice(null);
    try {
      const result = await apiV2.webhooks.test();
      setNotice(
        result.delivered
          ? { tone: 'good', text: `Delivered — HTTP ${result.status ?? '?'} in ${result.latencyMs ?? '?'} ms` }
          : { tone: 'bad', text: `Not delivered — HTTP ${result.status ?? '?'}` }
      );
    } catch (cause) {
      setNotice({ tone: 'bad', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="section-title">Webhooks</h2>
          <p className="muted">
            Get a call when a demo finishes, fails, or its flow goes stale. Works with any endpoint, and a Slack incoming webhook
            just works — paste the URL.
          </p>
        </div>
      </div>

      {loading && !state ? <SkeletonRows rows={2} /> : null}
      {error ? <ErrorPanel error={error} onRetry={refresh} what="the webhook settings" /> : null}

      {state ? (
        <div className="stack-sm">
          <div className="row row-between">
            <span className="muted">Current endpoint</span>
            <span className="mono truncate">{state.url ?? 'not configured'}</span>
          </div>
          <div className="row row-between">
            <span className="muted">Signing secret</span>
            <span className="mono">{state.hasSecret ? 'configured' : 'none'}</span>
          </div>
          {state.lastDelivery ? (
            <div className="row row-between">
              <span className="muted">Last delivery</span>
              <span className="mono">
                {state.lastDelivery.at ? formatDateTime(state.lastDelivery.at) : '—'}{' '}
                {state.lastDelivery.status ? `· HTTP ${state.lastDelivery.status}` : ''}
              </span>
            </div>
          ) : null}

          <Field label="Endpoint URL" htmlFor="webhook-url" hint="Generic JSON endpoint or a Slack incoming webhook URL.">
            <input
              id="webhook-url"
              className="input mono"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://hooks.slack.com/services/…"
              spellCheck={false}
            />
          </Field>

          <Field
            label="Signing secret"
            htmlFor="webhook-secret"
            optional
            hint="When set, every request carries X-Reelforge-Signature: sha256=HMAC(secret, body)."
          >
            <input
              id="webhook-secret"
              className="input mono"
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={state.hasSecret ? 'leave blank to keep the stored secret' : 'optional'}
            />
          </Field>

          <div className="row wrap">
            <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy !== null || url.trim() === ''}>
              {busy === 'save' ? 'Saving…' : 'Save webhook'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={sendTest} disabled={busy !== null || !state.url}>
              {busy === 'test' ? 'Sending…' : 'Send test event'}
            </button>
            {notice ? (
              <span className={notice.tone === 'good' ? 'hint good' : 'hint bad'} role="status">
                {notice.text}
              </span>
            ) : null}
          </div>

          <CodeBlock
            label="Verify the signature (Node)"
            code={`import crypto from "node:crypto";

const raw = body; // the exact bytes you received
const expected = "sha256=" + crypto
  .createHmac("sha256", process.env.WEBHOOK_SECRET)
  .update(raw)
  .digest("hex");

if (req.headers["x-reelforge-signature"] !== expected) {
  return res.status(401).end();
}`}
          />
        </div>
      ) : null}
    </section>
  );
}
