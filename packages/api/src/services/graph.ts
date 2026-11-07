import type { ArticleRow, FlowRow, FlowStepRow, GuideRow, ScreenRow } from '../../../core/src/types.ts';
import type { AuthContext } from '../auth.ts';
import { many, one } from '../dbq.ts';
import { notFound } from '../util.ts';
import { getEnvironmentRow } from './environments.ts';

export type FlowStepView = FlowStepRow & { idx: number };

export type FlowView = FlowRow & {
  stepCount: number;
  steps: FlowStepView[];
  articleCount: number;
  guideCount: number;
  environmentName: string;
  stale: boolean;
};

function stepsFor(flowId: string): FlowStepView[] {
  return many<FlowStepRow>('SELECT * FROM flow_steps WHERE flow_id = ? ORDER BY idx ASC', flowId).map((step) => ({
    ...step,
    idx: Number(step.idx)
  }));
}

function toFlowView(row: FlowRow, environmentName: string): FlowView {
  const steps = stepsFor(row.id);
  return {
    ...row,
    steps,
    stepCount: steps.length,
    articleCount: Number(
      one<{ n: number }>('SELECT COUNT(*) AS n FROM articles WHERE flow_id = ?', row.id)?.n ?? 0
    ),
    guideCount: Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM guides WHERE flow_id = ?', row.id)?.n ?? 0),
    environmentName,
    stale: row.status === 'stale'
  };
}

/** GET /api/environments/:id/graph/flows */
export function listFlows(auth: AuthContext, environmentId: string): FlowView[] {
  const env = getEnvironmentRow(auth, environmentId);
  const rows = many<FlowRow>(
    'SELECT * FROM flows WHERE environment_id = ? ORDER BY first_seen_at DESC, rowid DESC',
    environmentId
  );
  return rows.map((row) => toFlowView(row, env.name));
}

/** GET /api/environments/:id/graph/flows/:flowId */
export function getFlow(
  auth: AuthContext,
  environmentId: string,
  flowId: string
): { flow: FlowView; steps: FlowStepView[]; screens: ScreenRow[]; articles: ArticleRow[]; guides: Array<Pick<GuideRow, 'id' | 'name' | 'status' | 'embed_key'>> } {
  const env = getEnvironmentRow(auth, environmentId);
  const row = one<FlowRow>(
    'SELECT * FROM flows WHERE id = ? AND environment_id = ? AND workspace_id = ?',
    flowId,
    environmentId,
    auth.workspaceId
  );
  if (!row) throw notFound('flow', flowId);
  const steps = stepsFor(row.id);
  const urls = [...new Set(steps.map((step) => step.url).filter((url): url is string => Boolean(url)))];
  const screens = many<ScreenRow>(
    'SELECT * FROM screens WHERE environment_id = ? ORDER BY url_path ASC',
    environmentId
  ).filter((screen) => urls.length === 0 || urls.some((url) => url.endsWith(screen.url_path)));
  const articles = many<ArticleRow>(
    'SELECT * FROM articles WHERE flow_id = ? ORDER BY created_at DESC',
    flowId
  );
  const guides = many<Pick<GuideRow, 'id' | 'name' | 'status' | 'embed_key'>>(
    'SELECT id, name, status, embed_key FROM guides WHERE flow_id = ? ORDER BY created_at DESC',
    flowId
  );
  return { flow: toFlowView(row, env.name), steps, screens, articles, guides };
}

export function requireFlow(auth: AuthContext, environmentId: string, flowId: string): FlowRow {
  const row = one<FlowRow>(
    'SELECT * FROM flows WHERE id = ? AND environment_id = ? AND workspace_id = ?',
    flowId,
    environmentId,
    auth.workspaceId
  );
  if (!row) throw notFound('flow', flowId);
  return row;
}

export function listFlowOptions(auth: AuthContext): Array<{ flowId: string; name: string; environmentId: string; status: string }> {
  return many<{ flowId: string; name: string; environmentId: string; status: string }>(
    'SELECT id AS flowId, name, environment_id AS environmentId, status FROM flows WHERE workspace_id = ? ORDER BY first_seen_at DESC',
    auth.workspaceId
  );
}