/**
 * Reelforge OpenCode plugin — zero dependencies, no build step.
 *
 * Copy this file to `.opencode/plugin/reelforge.ts` in a project (or to
 * `~/.config/opencode/plugin/reelforge.ts` globally). OpenCode loads it at startup.
 *
 * It registers no tools, hooks or commands: the MCP server declared in
 * `opencode.json` does the actual work, and this file is a deliberate no-op while
 * Reelforge is healthy. Its only job is to make a common setup mistake obvious —
 * starting OpenCode before the Reelforge API — with one warning toast instead of a
 * wall of failing MCP calls.
 */
export const ReelforgePlugin = async ({ client }: { client?: any } = {}) => {
  const base = (process.env.REELFORGE_API_URL ?? 'http://127.0.0.1:4400/api').replace(/\/+$/, '');
  const healthUrl = `${base}/health`;

  const probe = async (): Promise<void> => {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message =
        `Reelforge MCP unreachable at ${base} (${detail}). Start it with: npm run api`;
      try {
        await client?.tui?.showToast?.({ body: { message, variant: 'warning' } });
      } catch {
        /* host without toasts — the console warning below is enough */
      }
      console.warn(`[reelforge] ${message}`);
    }
  };

  void probe();

  return {};
};

export default ReelforgePlugin;
