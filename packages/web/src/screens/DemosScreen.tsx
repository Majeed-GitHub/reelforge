import { useMemo } from 'react';
import type { DemoRow, EnvironmentRow } from '@core';
import { api } from '../api.ts';
import { formatDuration, formatNumber, formatRelative, hostOf, truncate } from '../format.ts';
import { useLoader, useNow, usePolling } from '../hooks.ts';
import { usePrivacy } from '../privacy.ts';
import { href, navigate } from '../router.ts';
import { Banner, DemoStatusPill, EmptyState, ErrorPanel, SkeletonRows } from '../components/ui.tsx';
import { Privacy } from '../components/Privacy.tsx';
import { Icon } from '../components/icons.tsx';

export function DemosScreen() {
  const demos = useLoader(() => api.demos.list(), []);
  const environments = useLoader(
    () => api.environments.list().catch((): EnvironmentRow[] => []),
    []
  );
  useNow(15_000);

  const rows = demos.data ?? [];
  const envById = useMemo(() => {
    const map = new Map<string, EnvironmentRow>();
    for (const environment of environments.data ?? []) map.set(environment.id, environment);
    return map;
  }, [environments.data]);

  const activeCount = rows.filter((row) => row.status === 'queued' || row.status === 'running').length;
  usePolling(demos.reload, activeCount > 0 ? 4000 : null);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Demos</h1>
          <p className="page-sub">
            Every recording is one run of the pipeline: browser capture, narration, render, then an article, a training doc and an
            in-app guide built from the same Product Graph.
          </p>
        </div>
        <div className="row">
          {activeCount > 0 ? (
            <span className="pill pill-running" title="A queued or running demo is polled every 4 seconds">
              <span className="dot" />
              Live · {activeCount} in flight
            </span>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={() => navigate(href.newDemo())}>
            <Icon name="plus" size={15} />
            New demo
          </button>
        </div>
      </div>

      {demos.error && demos.data ? (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="warn" title="Showing the last successful response">
            Refresh failed: {demos.error.message}
          </Banner>
        </div>
      ) : null}

      {demos.loading ? (
        <div className="card">
          <SkeletonRows rows={5} />
        </div>
      ) : demos.error ? (
        <ErrorPanel error={demos.error} onRetry={demos.reload} what="demos" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="demos"
          title="No demos yet"
          body="Point Reelforge at a URL and describe the walkthrough in one sentence. It drives a real Chromium window, records it, narrates it, and publishes the article and guide."
          action={
            <button type="button" className="btn btn-primary" onClick={() => navigate(href.newDemo())}>
              <Icon name="plus" size={15} />
              Record your first demo
            </button>
          }
          hint={
            <>
              No API key yet? <code>npm run seed</code> creates one and prints it once.
            </>
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Instruction</th>
                <th scope="col">Duration</th>
                <th scope="col">Credits</th>
                <th scope="col">Created</th>
                <th scope="col">Environment</th>
                <th scope="col" aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <DemoTableRow key={row.id} row={row} environment={row.environment_id ? envById.get(row.environment_id) : undefined} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 ? (
        <p className="hint" style={{ marginTop: 10 }}>
          {rows.length} demo{rows.length === 1 ? '' : 's'} in this workspace · newest first
        </p>
      ) : null}
    </div>
  );
}

function DemoTableRow({ row, environment }: { row: DemoRow; environment?: EnvironmentRow }) {
  const open = () => navigate(href.demo(row.id));
  const privacy = usePrivacy();
  return (
    <tr
      data-link=""
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
      aria-label={`Open demo: ${truncate(row.instruction, 80)}`}
    >
      <td>
        <div className="row" style={{ gap: 8 }}>
          <DemoStatusPill status={row.status} />
          {row.status === 'running' ? <span className="hint num">{Math.round(row.progress ?? 0)}%</span> : null}
        </div>
      </td>
      <td>
        <div className="cell-title" title={privacy ? undefined : row.instruction}>
          <Privacy label="demo instruction">{truncate(row.instruction, 88)}</Privacy>
        </div>
        <div className="hint mono" style={{ marginTop: 2 }}>
          <Privacy label="target URL">{truncate(hostOf(row.target_url), 40)}</Privacy>
        </div>
      </td>
      <td className="cell-num">{formatDuration(row.duration_ms)}</td>
      <td className="cell-num">{formatNumber(row.credits_used)}</td>
      <td className="cell-num" title={row.created_at}>
        {formatRelative(row.created_at)}
      </td>
      <td className="cell-num">
        {environment ? (
          <span title={privacy ? undefined : environment.base_url}>
            <Privacy label="environment name">{truncate(environment.name, 26)}</Privacy>
          </span>
        ) : row.environment_id ? (
          <span className="mono dim">{truncate(row.environment_id, 14)}</span>
        ) : (
          <span className="dim">one-off URL</span>
        )}
      </td>
      <td>
        <span className="row-arrow" aria-hidden="true">
          <Icon name="chevron-right" size={15} />
        </span>
      </td>
    </tr>
  );
}
