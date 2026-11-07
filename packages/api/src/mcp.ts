import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../core/src/http.ts';
import type { ArticleChannel, DemoOptions } from '../../core/src/types.ts';
import type { AuthContext } from './auth.ts';
import { authOf } from './auth.ts';
import type { DemoCreateBody } from './schemas.ts';
import { attachExtraTools } from './tools-extra.ts';
import { listApiKeys } from './services/apikeys.ts';
import { createArticleFromFlow, getArticle, listArticles, patchArticle, publishArticle } from './services/articles.ts';
import {
  answerQuestion,
  cancelDemo,
  createDemo,
  getDemo,
  getTranscript,
  listDemos,
  waitForDemo
} from './services/demos.ts';
import { attestDomain, listDomains } from './services/domains.ts';
import {
  createEnvironment,
  getEnvironment,
  listEnvironments,
  verifyEnvironment
} from './services/environments.ts';
import { getFlow, listFlows } from './services/graph.ts';
import { listIntegrations } from './services/integrations.ts';
import { listPresets, listVoices } from './services/presets.ts';
import { getWorkspace } from './services/workspace.ts';
import { reverifyFlow } from './reverify.ts';

/**
 * MCP server — one implementation, two transports.
 *
 * Every tool below calls the *same* service function the REST route calls, so
 * REST and MCP can never drift. `POST /api/mcp` speaks the streamable HTTP
 * transport in stateless mode: a fresh McpServer + transport per request, which
 * keeps it horizontally safe and avoids session bookkeeping.
 *
 * Tool args are snake_case (Director parity); results are JSON text.
 */

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown): ToolResult {
  const failure =
    error instanceof ApiError
      ? { code: error.code, message: error.message, remediation: error.remediation }
      : { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
  return { content: [{ type: 'text', text: JSON.stringify(failure, null, 2) }], isError: true };
}

function register(
  server: McpServer,
  name: string,
  description: string,
  shape: Record<string, z.ZodTypeAny>,
  execute: (args: Record<string, any>) => Promise<unknown> | unknown
): void {
  const callback = async (args: Record<string, any>): Promise<ToolResult> => {
    try {
      return jsonResult(await execute(args ?? {}));
    } catch (error) {
      return errorResult(error);
    }
  };
  (server.registerTool as unknown as (
    toolName: string,
    config: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
    cb: typeof callback
  ) => void)(name, { description, inputSchema: shape }, callback);
}

export function buildMcpServer(auth: AuthContext): McpServer {
  const server = new McpServer({ name: 'reelforge', version: '0.1.0' });

  // ---------------------------------------------------------------- demos --
  register(
    server,
    'create_demo',
    'Start a narrated demo recording. Returns { id, status:"queued", pollAfterSeconds }. Give either target_url or environment_id (+ optional path).',
    {
      instruction: z.string().min(3).max(2000).describe('What to demo, in one or two sentences.'),
      target_url: z.string().optional().describe('Where to record, e.g. https://app.example.com'),
      target_type: z.enum(['url', 'tunnel']).optional().describe('"url" (default) or "tunnel" (public HTTPS).'),
      environment_id: z.string().optional().describe('Saved product to record inside (joins its Product Graph).'),
      path: z.string().optional().describe('Start page, resolved against the environment base URL.'),
      authorized: z.boolean().optional().describe('Confirm once per new domain that you may record it.'),
      confirm_destructive: z.boolean().optional().describe('Allow destructive steps (delete/revoke).'),
      language: z.string().optional().describe('Narration/caption language, e.g. "en", "es", "hi".'),
      fps: z.number().int().min(1).max(60).optional(),
      max_steps: z.number().int().min(1).max(60).optional(),
      watermark: z.boolean().optional(),
      zoom: z.number().min(1).max(2.5).optional().describe('Auto-zoom strength, 1.6 default.'),
      voice: z.string().optional().describe('Narration voice override: auto | sapi | edge | openai:<voice> | none.')
    },
    async (args) => {
      if (!args.environment_id && !args.target_url) {
        throw new ApiError('VALIDATION_ERROR', 'Provide `target_url` or `environment_id`.', {
          action: 'fix_request',
          hint: 'e.g. {"instruction":"Invite a teammate","target_url":"https://app.example.com"}'
        });
      }
      const options: Record<string, unknown> = {};
      if (args.language !== undefined) options.language = args.language;
      if (args.fps !== undefined) options.fps = args.fps;
      if (args.max_steps !== undefined) options.maxSteps = args.max_steps;
      if (args.watermark !== undefined) options.watermark = args.watermark;
      if (args.zoom !== undefined) options.zoom = args.zoom;
      if (args.voice !== undefined) options.voice = args.voice;
      const body = {
        instruction: args.instruction,
        target: args.target_url ? { type: args.target_type ?? 'url', url: args.target_url } : undefined,
        environmentId: args.environment_id,
        path: args.path,
        authorized: args.authorized,
        confirmDestructive: args.confirm_destructive,
        options: Object.keys(options).length > 0 ? (options as DemoOptions) : undefined
      } as DemoCreateBody;
      return createDemo(auth, body);
    }
  );

  register(
    server,
    'get_demo_status',
    'Current status of a demo: status, progress, videoUrl, outcome, failure, question, pollAfterSeconds.',
    { demo_id: z.string().describe('Demo id, e.g. dem_l8x2k9q3') },
    async (args) => getDemo(auth, args.demo_id)
  );

  register(
    server,
    'wait_for_demo',
    'Block until a demo finishes (or up to 180 seconds elapse), then return its status.',
    {
      demo_id: z.string(),
      timeout_seconds: z.number().int().min(1).max(180).optional().describe('Default 180, max 180.')
    },
    async (args) => waitForDemo(auth, args.demo_id, (args.timeout_seconds ?? 180) * 1000)
  );

  register(
    server,
    'answer_demo_question',
    'Answer a question the recorder asked before continuing (optionId from the demo question).',
    {
      demo_id: z.string(),
      option_id: z.string().describe('One of the option ids in the demo question.')
    },
    async (args) => answerQuestion(auth, args.demo_id, args.option_id)
  );

  register(
    server,
    'get_demo_transcript',
    'Narration lines for a demo, with start offsets and durations in ms.',
    { demo_id: z.string() },
    async (args) => getTranscript(auth, args.demo_id)
  );

  register(
    server,
    'cancel_demo',
    'Cancel a queued or running demo.',
    { demo_id: z.string() },
    async (args) => cancelDemo(auth, args.demo_id)
  );

  register(
    server,
    'list_demos',
    'Recent demos in this workspace, newest first (max 100).',
    { limit: z.number().int().min(1).max(100).optional() },
    async (args) => listDemos(auth, args.limit ?? 20)
  );

  // --------------------------------------------------------- environments --
  register(
    server,
    'create_environment',
    'Save a product (name + base URL + sign-in mode) so demos can join its Product Graph.',
    {
      name: z.string().min(1),
      base_url: z.string().min(1).describe('e.g. https://app.example.com'),
      sign_in_mode: z.enum(['none', 'password', 'session']).optional(),
      username: z.string().optional(),
      password: z.string().optional().describe('Stored AES-256-GCM encrypted at rest.')
    },
    async (args) =>
      createEnvironment(auth, {
        name: args.name,
        baseUrl: args.base_url,
        signInMode: args.sign_in_mode,
        credentials:
          args.username && args.password ? { username: args.username, password: args.password } : undefined
      })
  );

  register(server, 'list_environments', 'Every saved product/environment in this workspace.', {}, async () =>
    listEnvironments(auth)
  );

  register(
    server,
    'get_environment',
    'One environment, including its screens and whether a session is stored.',
    { environment_id: z.string() },
    async (args) => getEnvironment(auth, args.environment_id)
  );

  register(
    server,
    'verify_environment',
    'Check the stored sign-in is present and structurally valid (no browser launched).',
    { environment_id: z.string() },
    async (args) => verifyEnvironment(auth, args.environment_id)
  );

  // ----------------------------------------------------------------- graph --
  register(
    server,
    'list_graph_flows',
    'Every flow in a product\'s Product Graph, with status, steps and dependent article/guide counts.',
    { environment_id: z.string() },
    async (args) => listFlows(auth, args.environment_id)
  );

  register(
    server,
    'get_graph_flow',
    'One flow with its steps, screens, and the articles/guides generated from it.',
    { environment_id: z.string(), flow_id: z.string() },
    async (args) => getFlow(auth, args.environment_id, args.flow_id)
  );

  register(
    server,
    'reverify_flow',
    'Re-check a flow against the live product without recording; marks it stale and flags dependent articles when it drifted.',
    { environment_id: z.string(), flow_id: z.string() },
    async (args) => reverifyFlow(auth, args.environment_id, args.flow_id)
  );

  // --------------------------------------------------------------- domains --
  register(
    server,
    'attest_domain',
    'Confirm once that you may record a host (resolves DOMAIN_AUTHORIZATION_REQUIRED).',
    { host: z.string().describe('e.g. app.example.com'), authorized: z.boolean().optional() },
    async (args) => attestDomain(auth, { host: args.host, authorized: args.authorized })
  );

  register(server, 'list_domains', 'Domains this workspace has attested or verified.', {}, async () =>
    listDomains(auth)
  );

  // -------------------------------------------------------------- articles --
  register(
    server,
    'create_article_from_flow',
    'Write a step-by-step article from a Product Graph flow (help_center or internal_training).',
    {
      flow_id: z.string(),
      channel: z.enum(['help_center', 'internal_training']),
      environment_id: z.string().optional()
    },
    async (args) =>
      createArticleFromFlow(auth, {
        flowId: args.flow_id,
        channel: args.channel as ArticleChannel,
        environmentId: args.environment_id
      })
  );

  register(
    server,
    'list_articles',
    'Articles in this workspace, optional channel/status filter.',
    {
      limit: z.number().int().min(1).max(100).optional(),
      channel: z.enum(['help_center', 'internal_training']).optional(),
      status: z.enum(['draft', 'published']).optional()
    },
    async (args) =>
      listArticles(auth, {
        limit: args.limit,
        channel: args.channel as ArticleChannel | undefined,
        status: args.status
      })
  );

  register(
    server,
    'get_article',
    'One article with body, excerpt, status and whether its flow has gone stale.',
    { article_id: z.string() },
    async (args) => getArticle(auth, args.article_id)
  );

  register(
    server,
    'update_article',
    'Edit an article: title, excerpt, body_md, channel or status.',
    {
      article_id: z.string(),
      title: z.string().optional(),
      excerpt: z.string().optional(),
      body_md: z.string().optional(),
      channel: z.enum(['help_center', 'internal_training']).optional(),
      status: z.enum(['draft', 'published']).optional()
    },
    async (args) =>
      patchArticle(auth, args.article_id, {
        title: args.title,
        excerpt: args.excerpt,
        body_md: args.body_md,
        channel: args.channel as ArticleChannel | undefined,
        status: args.status
      })
  );

  register(
    server,
    'publish_article',
    'Publish an article (sets status published and a published URL).',
    { article_id: z.string() },
    async (args) => publishArticle(auth, args.article_id)
  );

  // --------------------------------------------------------------- presets --
  register(server, 'list_recording_presets', 'Saved recording presets plus the narration voices this build supports.', {}, async () => ({
    presets: listPresets(auth),
    ...listVoices()
  }));

  // ----------------------------------------------------------- integrations --
  register(server, 'list_integrations', 'Helpdesk/chat/webhook integrations and whether they are configured.', {}, async () =>
    listIntegrations(auth)
  );

  // Workspace + keys are useful for agents debugging auth.
  register(server, 'get_workspace', 'Workspace identity, plan limits and usage counters.', {}, async () =>
    getWorkspace(auth)
  );

  register(server, 'list_api_keys', 'API keys for this workspace (prefixes only; plaintext is never stored).', {}, async () =>
    listApiKeys(auth)
  );

  // Local-only helper tools live in a separate module to keep this file readable.
  attachExtraTools(server, auth, register);

  return server;
}

/**
 * POST /api/mcp — stateless streamable HTTP.
 *
 * Fastify has already parsed the JSON body, so it is handed to the transport as
 * `parsedBody` (the raw stream is consumed at this point). `reply.hijack()`
 * stops Fastify from also trying to answer.
 */
export async function handleMcpRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = authOf(request);
  const server = buildMcpServer(auth);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  reply.hijack();
  try {
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } catch (error) {
    if (!reply.raw.headersSent) {
      const message = error instanceof Error ? error.message : String(error);
      reply.raw.writeHead(500, { 'content-type': 'application/json' });
      reply.raw.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: `MCP request failed: ${message}` }
        })
      );
    }
  } finally {
    // The response is complete for JSON responses; SSE streams are closed by the client.
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
  }
}