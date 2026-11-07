#!/usr/bin/env node
/**
 * stdio ↔ streamable-HTTP bridge for Reelforge's MCP server.
 *
 * Why this exists: Claude Desktop (and several other MCP clients) can only speak
 * MCP over stdio — they cannot open an HTTP session. Reelforge's server is a
 * remote streamable-HTTP endpoint, so those clients need a local process that
 *
 *   1. speaks MCP over stdin/stdout to the client, and
 *   2. speaks MCP over HTTP to {api}/mcp,
 *
 * forwarding tools, resources and prompts unchanged. That is this file.
 *
 *   node packages/cli/src/mcp-stdio.ts --stdio \
 *     --api-url http://127.0.0.1:4400/api --api-key rg_…
 *
 * Claude Desktop config (claude_desktop_config.json):
 *
 *   {
 *     "mcpServers": {
 *       "reelforge": {
 *         "command": "node",
 *         "args": ["/abs/path/to/reelforge/packages/cli/src/mcp-stdio.ts", "--stdio"],
 *         "env": { "REELFORGE_API_URL": "http://127.0.0.1:4400/api",
 *                  "REELFORGE_API_KEY": "rg_…" }
 *       }
 *     }
 *   }
 *
 * stdout belongs to the protocol: every diagnostic goes to stderr.
 */
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const VERSION = '0.2.0';

function arg(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : fallback;
}

const apiUrl = (arg('api-url', process.env.REELFORGE_API_URL ?? 'http://127.0.0.1:4400/api')).replace(/\/+$/, '');
const apiKey = arg('api-key', process.env.REELFORGE_API_KEY ?? '');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stderr.write(
    [
      'Reelforge MCP stdio bridge',
      '',
      '  node packages/cli/src/mcp-stdio.ts --stdio [--api-url URL] [--api-key rg_…]',
      '',
      'Env: REELFORGE_API_URL, REELFORGE_API_KEY',
      ''
    ].join('\n')
  );
  process.exit(0);
}

if (!process.argv.includes('--stdio')) {
  process.stderr.write('Refusing to run without --stdio (stdout would be used as a terminal, not as a protocol channel).\n');
  process.exit(1);
}

/** The remote server, spoken to over streamable HTTP. */
const remote = new Client({ name: 'reelforge-stdio-bridge', version: VERSION }, { capabilities: {} });

const mcpEndpoint = `${apiUrl}/mcp`;

async function connectRemote(): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpEndpoint), {
    requestInit: {
      headers: {
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        accept: 'application/json, text/event-stream'
      }
    }
  });
  await remote.connect(transport);
}

/**
 * The local server we expose to the client. Capabilities are declared up front;
 * if the remote does not implement one of them the corresponding list call just
 * forwards the remote's (empty) answer.
 */
const local = new Server(
  { name: 'reelforge', version: VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } }
);

local.setRequestHandler(ListToolsRequestSchema, async () => {
  const result = await remote.listTools();
  return { tools: result.tools ?? [] };
});

local.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  // Forward verbatim: the remote already returns the MCP CallToolResult shape
  // (including isError + the {code,message,remediation} payload in `content`).
  return (await remote.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> })) as never;
});

local.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const result = await remote.listResources();
    return { resources: result.resources ?? [] };
  } catch {
    return { resources: [] };
  }
});

local.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  // Concrete resources come from resources/list; templates are how a client
  // discovers the parameterised ones (reelforge://demos/{id} and friends).
  try {
    const result = await remote.listResourceTemplates();
    return { resourceTemplates: result.resourceTemplates ?? [] };
  } catch {
    return { resourceTemplates: [] };
  }
});

local.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  return (await remote.readResource({ uri: request.params.uri })) as never;
});

local.setRequestHandler(ListPromptsRequestSchema, async () => {
  try {
    const result = await remote.listPrompts();
    return { prompts: result.prompts ?? [] };
  } catch {
    return { prompts: [] };
  }
});

local.setRequestHandler(GetPromptRequestSchema, async (request) => {
  return (await remote.getPrompt({
    name: request.params.name,
    arguments: (request.params.arguments ?? {}) as Record<string, string>
  })) as never;
});

async function main(): Promise<void> {
  process.stderr.write(`[reelforge] bridging stdio -> ${mcpEndpoint}${apiKey ? ' (key set)' : ' (no key)'}\n`);

  try {
    await connectRemote();
  } catch (error) {
    process.stderr.write(
      `[reelforge] could not reach ${mcpEndpoint}: ${error instanceof Error ? error.message : String(error)}\n` +
        '  Is the API running (`npm run api`), and is the key correct (`npm run seed`)?\n'
    );
    process.exit(1);
  }

  const advertised = await remote.listTools().catch(() => ({ tools: [] as unknown[] }));
  process.stderr.write(`[reelforge] remote is up: ${advertised.tools?.length ?? 0} tool(s) available\n`);

  const transport = new StdioServerTransport();
  await local.connect(transport);
  process.stderr.write('[reelforge] stdio ready\n');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void local.close().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  process.stderr.write(`[reelforge] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
