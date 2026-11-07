/**
 * `reelforge mcp` — wire Reelforge's MCP server into a coding agent.
 *
 * Writes the agent's own config file (project-local by default, --global for
 * the user-level one), preserving everything else already in the file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiCall, resolveApi } from './util.ts';

type AgentName = 'claude-code' | 'cursor' | 'claude-desktop';

type AgentTarget = {
  name: AgentName;
  label: string;
  file: (global: boolean) => string;
  /** Shape of one server entry in that agent's config format. */
  entry: (url: string, key: string) => Record<string, unknown>;
  /** Key under which servers live in the file. */
  root: string;
};

const AGENTS: AgentTarget[] = [
  {
    name: 'claude-code',
    label: 'Claude Code',
    file: (global) => (global ? path.join(os.homedir(), '.claude.json') : path.join(process.cwd(), '.mcp.json')),
    root: 'mcpServers',
    entry: (url, key) => ({ type: 'http', url, headers: { 'X-API-Key': key } })
  },
  {
    name: 'cursor',
    label: 'Cursor',
    file: (global) =>
      global ? path.join(os.homedir(), '.cursor', 'mcp.json') : path.join(process.cwd(), '.cursor', 'mcp.json'),
    root: 'mcpServers',
    entry: (url, key) => ({ url, headers: { 'X-API-Key': key } })
  },
  {
    name: 'claude-desktop',
    label: 'Claude Desktop',
    file: () =>
      process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
        : path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    root: 'mcpServers',
    entry: (url, key) => ({ type: 'http', url, headers: { 'X-API-Key': key } })
  }
];

function readJson(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    console.error(`  ! ${file} is not valid JSON — leaving it alone.`);
    return {};
  }
}

export async function runMcp(flags: Record<string, string | boolean>): Promise<void> {
  const config = resolveApi(flags);
  if (!config.apiKey) {
    throw new Error(
      'No API key. Pass --api-key rg_… or set REELFORGE_API_KEY.\n' +
        '  Get one from the dashboard (Settings → API keys) or run `npm run seed`.'
    );
  }

  // Confirm the key actually works before writing it into an agent config.
  try {
    await apiCall(config, '/demos?limit=1');
  } catch (error) {
    throw new Error(`That API key was rejected by ${config.apiUrl}: ${error instanceof Error ? error.message : error}`);
  }

  const mcpUrl = `${config.apiUrl.replace(/\/api$/, '')}/api/mcp`;
  const requested = flags.agent;
  const names = (
    requested === undefined
      ? ['claude-code', 'cursor']
      : Array.isArray(requested)
        ? requested
        : [requested]
  ).map(String) as AgentName[];

  const targets = AGENTS.filter((a) => names.includes(a.name));
  if (targets.length === 0) {
    throw new Error(`Unknown agent(s): ${names.join(', ')}. Use claude-code, cursor or claude-desktop.`);
  }

  console.log(`\nMCP endpoint: ${mcpUrl}\n`);

  for (const agent of targets) {
    const file = agent.file(Boolean(flags.global));
    const configJson = readJson(file);
    const servers = (configJson[agent.root] ??= {});
    servers.reelforge = agent.entry(mcpUrl, config.apiKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(configJson, null, 2)}\n`, 'utf8');
    console.log(`  ✔ ${agent.label}: ${file}`);
  }

  console.log(
    '\nRestart the agent, then ask it: "record a demo of signing up on http://127.0.0.1:4402".\n' +
      `Tools available: create_demo, get_demo_status, wait_for_demo, list_graph_flows, create_article_from_flow, …\n`
  );
}
