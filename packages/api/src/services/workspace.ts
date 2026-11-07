import { PLAN } from '../../../core/src/config.ts';
import { remainingSeconds } from '../../../core/src/credits.ts';
import { ApiError } from '../../../core/src/http.ts';
import type { WorkspaceRow } from '../../../core/src/types.ts';
import type { AuthContext } from '../auth.ts';
import { one } from '../dbq.ts';

export type WorkspaceView = {
  id: string;
  name: string;
  created_at: string;
  apiKeyName: string;
  limits: {
    concurrency: number;
    freeMinutesPerMonth: number;
    minBillableSeconds: number;
    enforceCredits: boolean;
  };
  usage: {
    demos: number;
    environments: number;
    flows: number;
    articles: number;
    guides: number;
    creditsUsed: number;
    secondsRemaining: number | null;
  };
};

function count(sql: string, workspaceId: string): number {
  return Number(one<{ n: number }>(sql, workspaceId)?.n ?? 0);
}

/** GET /api/workspace — top-bar identity + plan telemetry for the dashboard. */
export function getWorkspace(auth: AuthContext): WorkspaceView {
  const row = one<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', auth.workspaceId);
  if (!row) throw new ApiError('NOT_FOUND', 'Workspace not found for this API key.', { action: 'provide_api_key' });
  const secondsUsed = Number(
    one<{ total: number | null }>('SELECT SUM(delta_seconds) AS total FROM credit_ledger WHERE workspace_id = ?', auth.workspaceId)
      ?.total ?? 0
  );
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    apiKeyName: auth.keyName,
    limits: {
      concurrency: PLAN.concurrency,
      freeMinutesPerMonth: PLAN.freeMinutesPerMonth,
      minBillableSeconds: PLAN.minBillableSeconds,
      enforceCredits: PLAN.enforceCredits
    },
    usage: {
      demos: count('SELECT COUNT(*) AS n FROM demos WHERE workspace_id = ?', auth.workspaceId),
      environments: count('SELECT COUNT(*) AS n FROM environments WHERE workspace_id = ?', auth.workspaceId),
      flows: count('SELECT COUNT(*) AS n FROM flows WHERE workspace_id = ?', auth.workspaceId),
      articles: count('SELECT COUNT(*) AS n FROM articles WHERE workspace_id = ?', auth.workspaceId),
      guides: count('SELECT COUNT(*) AS n FROM guides WHERE workspace_id = ?', auth.workspaceId),
      creditsUsed: Math.round((secondsUsed / 60) * 1000) / 1000,
      secondsRemaining: remainingSeconds(secondsUsed)
    }
  };
}