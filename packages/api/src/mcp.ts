import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../core/src/http.ts';
import type { ArticleChannel } from '../../core/src/types.ts';
import type { AuthContext } from './auth.ts';
import { authOf } from './auth.ts';
import { attachExtraTools, demoCreateBody } from './tools-extra.ts';
import { VERSION } from './routes/health.ts';
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
import { getFlow, listFlowOptions, listFlows } from './services/graph.ts';
import { getGuideByEmbedKey, listGuides } from './services/guides.ts';
import { listIntegrations } from './services/integrations.ts';
import { listPresets, listVoices } from './services/presets.ts';
import { getWorkspace } from './services/workspace.ts';
import { reverifyFlow } from './reverify.ts';
import { notFound } from './util.ts';

/**
 * MCP server — one implementation, two transports.
 *
 * Every tool below calls the *same* service function the REST route calls, so
 * REST and MCP can never drift. `POST /api/mcp` speaks the streamable HTTP
 * transport in stateless mode: a fresh McpServer + transport per request, which
 * keeps it horizontally safe and avoids session bookkeeping.
 *
 * The server also exposes:
 *   resources  reelforge://demos/{id} · flows/{id} · articles/{id} · guides/{embedKey}
 *              (JSON text + mimeType, readable without a tool round-trip)
 *   prompts    record-demo · write-article · fix-stale-flow · summarise-product
 *              (named MCP prompt templates that encode the multi-step playbooks)
 *
 * Tool args are snake_case (Director parity); results are JSON text and every
 * failure is { code, message, remediation } with `isError: true`.
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

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

type ResourceListing = { uri: string; name: string; description: string; mimeType: string };

function jsonResource(uri: URL, data: unknown): {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
} {
  return {
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }]
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function promptResult(description: string, text: string): {
  description: string;
  messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>;
} {
  return { description, messages: [{ role: 'user', content: { type: 'text', text } }] };
}

export function buildMcpServer(auth: AuthContext): McpServer {
  const server = new McpServer({ name: 'reelforge', version: VERSION });

  // -------------------------------------------------------------- resources --
  //
  // Four URI templates, one per domain object. The read callbacks reuse the
  // same service functions the tools use, so a resource can never show a
  // different shape than the matching tool.

  server.registerResource(
    'demo',
    new ResourceTemplate('reelforge://demos/{id}', {
      list: async (): Promise<{ resources: ResourceListing[] }> => ({
        resources: listDemos(auth, 25).map((demo) => ({
          uri: `reelforge://demos/${demo.id}`,
          name: demo.instruction || demo.id,
          description: `Demo ${demo.id} — ${demo.status}, ${demo.duration_ms ?? 0}ms, target ${demo.targetUrl}`,
          mimeType: 'application/json'
        }))
      })
    }),
    {
      title: 'Reelforge demo',
      description: 'One demo: status, progress, signed media links, outcome, failure and per-step narration timings.',
      mimeType: 'application/json'
    },
    async (uri, variables) => jsonResource(uri, getDemo(auth, String(variables.id ?? '')))
  );

  server.registerResource(
    'flow',
    new ResourceTemplate('reelforge://flows/{id}', {
      list: async (): Promise<{ resources: ResourceListing[] }> => ({
        resources: listFlowOptions(auth)
          .slice(0, 50)
          .map((flow) => ({
            uri: `reelforge://flows/${flow.flowId}`,
            name: flow.name,
            description: `Flow ${flow.flowId} — status ${flow.status}, environment ${flow.environmentId}`,
            mimeType: 'application/json'
          }))
      })
    }),
    {
      title: 'Reelforge Product Graph flow',
      description: 'One recorded flow with its steps, screens, dependent articles and guides. Staleness lives here.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const flowId = String(variables.id ?? '');
      const match = listFlowOptions(auth).find((flow) => flow.flowId === flowId);
      if (!match) throw notFound('flow', flowId);
      return jsonResource(uri, getFlow(auth, match.environmentId, flowId));
    }
  );

  server.registerResource(
    'article',
    new ResourceTemplate('reelforge://articles/{id}', {
      list: async (): Promise<{ resources: ResourceListing[] }> => ({
        resources: listArticles(auth, { limit: 25 }).map((article) => ({
          uri: `reelforge://articles/${article.id}`,
          name: article.title,
          description: `Article ${article.id} — ${article.channel}, status ${article.status}${article.stale ? ', flow stale' : ''}`,
          mimeType: 'application/json'
        }))
      })
    }),
    {
      title: 'Reelforge article',
      description: 'One help-centre or internal-training article with Markdown body, excerpt, status and stale flag.',
      mimeType: 'application/json'
    },
    async (uri, variables) => jsonResource(uri, getArticle(auth, String(variables.id ?? '')))
  );

  server.registerResource(
    'guide',
    new ResourceTemplate('reelforge://guides/{embedKey}', {
      list: async (): Promise<{ resources: ResourceListing[] }> => ({
        resources: listGuides(auth)
          .slice(0, 50)
          .map((guide) => ({
            uri: `reelforge://guides/${guide.embed_key}`,
            name: guide.name,
            description: `In-app guide ${guide.id} — ${guide.status}, ${guide.stepCount} step(s), embed key ${guide.embed_key}`,
            mimeType: 'application/json'
          }))
      })
    }),
    {
      title: 'Reelforge in-app guide (embed payload)',
      description:
        'The exact public payload the embed widget walks for an embed key: guide id, name, status, steps. Works for draft guides too.',
      mimeType: 'application/json'
    },
    async (uri, variables) => jsonResource(uri, getGuideByEmbedKey(String(variables.embedKey ?? '')))
  );

  // ---------------------------------------------------------------- prompts --

  server.registerPrompt(
    'record-demo',
    {
      title: 'Record a narrated demo',
      description:
        'End-to-end playbook for recording a demo of a URL for a stated goal: create, poll, answer questions, collect media. Requires url and goal.',
      argsSchema: {
        url: z.string().describe('The page to record, e.g. https://app.example.com/signup'),
        goal: z.string().describe('What the demo must show, in one sentence.')
      }
    },
    async (args) =>
      promptResult(
        `Record a demo of ${args.url}`,
        [
          `You are using Reelforge over MCP. Record one narrated demo video of ${args.url} showing: ${args.goal}.`,
          '',
          'Work in this order:',
          `1. Call health once to confirm the API is reachable and the worker is running. If worker.running is false, stop and report it.`,
          `2. Call create_demo with instruction "${String(args.goal).replace(/"/g, "'")}", target_url "${args.url}" and authorized: true only if you have already confirmed you may record this host. If the tool returns DOMAIN_AUTHORIZATION_REQUIRED, ask the operator before attesting.`,
          '3. Poll get_demo_status using the returned pollAfterSeconds, or call wait_for_demo with the demo id (up to 180s).',
          '4. If status is "question", call answer_demo_question with one of the option ids in question.options. If status is "failed", read failure.remediation and either fix the request or report it — do not silently retry more than once.',
          '5. On "complete": call get_demo_video for the signed MP4/poster links, get_transcript_markdown for the narration, and share_demo_link if the user wants to send it outside the workspace.',
          '6. Report the demo id, status, duration, credit cost and the video URL. Never invent ids or URLs — use exactly what the tools returned.',
          '',
          'Constraints: always narrate in the language the user asked for; pass language in create_demo if it is not English. Do not use confirm_destructive unless the user explicitly approved destructive steps.'
        ].join('\n')
      )
  );

  server.registerPrompt(
    'write-article',
    {
      title: 'Write a help-centre article from a flow',
      description:
        'Turn a Product Graph flow into a reviewed, published help-centre article. Requires flow_id (use list_graph_flows/list_articles to discover one).',
      argsSchema: {
        flow_id: z.string().describe('Product Graph flow id, e.g. flw_…')
      }
    },
    async (args) =>
      promptResult(
        `Write an article from flow ${args.flow_id}`,
        [
          `You are using Reelforge over MCP. Write and publish a help-centre article from Product Graph flow ${args.flow_id}.`,
          '',
          'Work in this order:',
          `1. Call list_graph_flows for the environment that owns the flow (call list_environments if you do not know it) and confirm the flow id. Call get_graph_flow to read the real steps, selectors and screens.`,
          `2. Call create_article_from_flow with flow_id "${args.flow_id}" and channel "help_center".`,
          '3. Read the returned draft. If get_article reports stale: true, do not publish — tell the user the flow has drifted and offer fix-stale-flow first.',
          '4. Optionally call update_article to tighten the title/excerpt/body_md. Keep the original step order; do not invent UI elements.',
          '5. Only after the user approves the draft, call publish_article and report the published URL.',
          '6. If the user asked for internal training instead, re-run create_article_from_flow with channel "internal_training".',
          '',
          'Never publish without explicit approval.'
        ].join('\n')
      )
  );

  server.registerPrompt(
    'fix-stale-flow',
    {
      title: 'Fix a stale Product Graph flow',
      description:
        'Diagnose a stale flow, re-verify it, re-record if needed and regenerate dependent documentation. Requires flow_id.',
      argsSchema: {
        flow_id: z.string().describe('Product Graph flow id that has gone stale, e.g. flw_…')
      }
    },
    async (args) =>
      promptResult(
        `Fix stale flow ${args.flow_id}`,
        [
          `You are using Reelforge over MCP. Flow ${args.flow_id} is suspected stale.`,
          '',
          'Work in this order:',
          `1. Find the flow's environment: call list_environments, then list_graph_flows per environment, or get_graph_flow when you know the environment id. Confirm the flow id and read its steps, articleCount and guideCount.`,
          `2. Call reverify_flow for that flow. It re-checks the live product without recording and marks the flow stale when the UI drifted.`,
          '3. If the flow is still fresh, report that nothing changed and stop.',
          '4. If stale, call create_demo with environment_id set to the flow\'s environment and an instruction that matches the flow name, to re-record it. Poll get_demo_status / wait_for_demo to completion.',
          '5. After a successful re-record, call create_article_from_flow(flow_id, channel) for each dependent channel to regenerate documentation, then list_guides and publish_guide only if the user approves.',
          '6. Summarise what drifted, what was re-recorded and which articles/guides were refreshed.'
        ].join('\n')
      )
  );

  server.registerPrompt(
    'summarise-product',
    {
      title: 'Summarise a saved product',
      description:
        'Produce an operator summary of one saved product: flows and their freshness, documentation coverage, guides and demo history. Requires environment_id.',
      argsSchema: {
        environment_id: z.string().describe('Saved product (environment) id, e.g. env_…')
      }
    },
    async (args) =>
      promptResult(
        `Summarise product ${args.environment_id}`,
        [
          `You are using Reelforge over MCP. Summarise saved product ${args.environment_id} for its owner.`,
          '',
          'Gather facts with tools (never guess):',
          `1. get_environment "${args.environment_id}" — name, base URL, screens, whether a sign-in session is stored.`,
          '2. list_graph_flows — every flow with status, step count, articleCount, guideCount.',
          '3. list_articles (filter by the environment in the response) and list_guides — what documentation exists and whether it is draft/published/live.',
          '4. list_demos and, for the most recent complete demos, get_demo_video / get_transcript_markdown only when the summary needs media detail.',
          '',
          'Then answer with: product overview; flow count plus how many are stale; documentation coverage (which flows have no article, which articles are draft); guides live vs draft; recent demo activity; and the top three fixes in priority order. Cite ids for everything. Keep it under 300 words.'
        ].join('\n')
      )
  );

  // ---------------------------------------------------------------- demos --
  register(
    server,
    'create_demo',
    'Start a narrated demo recording of a URL or saved product. Use this whenever the user asks to record, capture or show a product flow. Required: instruction (what to show) plus either target_url or environment_id (plus optional path). Returns: { id, status:"queued", pollAfterSeconds, environmentId } — poll get_demo_status or call wait_for_demo next.',
    {
      instruction: z.string().min(3).max(2000).describe('What to demo, in one or two sentences.'),
      target_url: z.string().optional().describe('Where to record, e.g. https://app.example.com'),
      target_type: z.enum(['url', 'tunnel']).optional().describe('"url" (default) or "tunnel" (public HTTPS).'),
      environment_id: z.string().optional().describe('Saved product to record inside (joins its Product Graph).'),
      path: z.string().optional().describe('Start page, resolved against the environment base URL.'),
      authorized: z.boolean().optional().describe('Confirm once per new domain that you may record it.'),
      confirm_destructive: z.boolean().optional().describe('Allow destructive steps (delete/revoke).'),
      language: z.string().optional().describe('Narration/caption language, e.g. "en", "es", "hi".'),
      fps: z.number().int().min(1).max(60).optional().describe('Recording frame rate, default 30.'),
      max_steps: z.number().int().min(1).max(60).optional().describe('Step budget, default 40.'),
      watermark: z.boolean().optional().describe('Burn the Reelforge wordmark. Default true.'),
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
      return createDemo(auth, demoCreateBody(args));
    }
  );

  register(
    server,
    'get_demo_status',
    'Check one demo\'s current state without blocking: status, progress, videoUrl, outcome, failure and question. Use after create_demo and while a run is in flight; prefer wait_for_demo when you can afford to block. Required: demo_id. Returns the demo view (pollAfterSeconds tells you when to ask again; null when finished).',
    { demo_id: z.string().describe('Demo id, e.g. dem_l8x2k9q3') },
    async (args) => getDemo(auth, args.demo_id)
  );

  register(
    server,
    'wait_for_demo',
    'Block until a demo finishes (complete/failed/cancelled) or the timeout expires, then return its full status. Use instead of polling when the run is short and the agent can wait. Required: demo_id; optional timeout_seconds (default 180, max 180). Returns the same demo view as get_demo_status.',
    {
      demo_id: z.string().describe('Demo id to wait for.'),
      timeout_seconds: z.number().int().min(1).max(180).optional().describe('Default 180, max 180.')
    },
    async (args) => waitForDemo(auth, args.demo_id, (args.timeout_seconds ?? 180) * 1000)
  );

  register(
    server,
    'answer_demo_question',
    'Answer a pre-recording question the planner asked (for example, which test account to use) so the run can continue. Use only when get_demo_status returns a non-null question. Required: demo_id and option_id (one of question.options[].id). Returns: { ok, demoId, optionId, answeredAt }.',
    {
      demo_id: z.string().describe('Demo waiting on the question.'),
      option_id: z.string().describe('One of the option ids in the demo question.')
    },
    async (args) => answerQuestion(auth, args.demo_id, args.option_id)
  );

  register(
    server,
    'get_demo_transcript',
    'Return a demo\'s narration lines with start offsets and durations in milliseconds. Use when you need machine-readable timing (captions, sync, analysis); for a paste-ready document use get_transcript_markdown instead. Required: demo_id. Returns: { demoId, lines: [ { stepIndex, text, startMs, durationMs } ] }.',
    { demo_id: z.string().describe('Demo id from create_demo/list_demos.') },
    async (args) => getTranscript(auth, args.demo_id)
  );

  register(
    server,
    'cancel_demo',
    'Cancel a queued or running demo so it stops consuming a worker slot. Use when a recording was started by mistake or the target changed. Required: demo_id. Returns: { id, status:"cancelled", cancelled }. Finished demos cannot be cancelled.',
    { demo_id: z.string().describe('Queued or running demo id.') },
    async (args) => cancelDemo(auth, args.demo_id)
  );

  register(
    server,
    'list_demos',
    'List recent demos in this workspace, newest first (max 100), with status, duration and media links. Use to discover demo ids before get_demo_status/get_demo_video/list_outputs. Args: limit optional (1–100, default 20). Returns: array of demo views; steps are included.',
    { limit: z.number().int().min(1).max(100).optional().describe('Max demos, default 20.') },
    async (args) => listDemos(auth, args.limit ?? 20)
  );

  // --------------------------------------------------------- environments --
  register(
    server,
    'create_environment',
    'Save a product (name + base URL + sign-in mode) so future demos join its Product Graph instead of creating an implicit environment. Use before a series of recordings of the same app, or when a saved sign-in is needed. Required: name and base_url; optional sign_in_mode/username/password (password is encrypted at rest). Returns the environment view.',
    {
      name: z.string().min(1).describe('Human name for the product.'),
      base_url: z.string().min(1).describe('e.g. https://app.example.com'),
      sign_in_mode: z.enum(['none', 'password', 'session']).optional().describe('How the recorder signs in; default "none".'),
      username: z.string().optional().describe('Test account username (only with sign_in_mode "password").'),
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

  register(
    server,
    'list_environments',
    'List every saved product/environment in this workspace with base URL, sign-in mode and session state. Use to discover environment ids before create_demo, list_graph_flows or summarise-product. Args: none. Returns an array of environments.',
    {},
    async () => listEnvironments(auth)
  );

  register(
    server,
    'get_environment',
    'Fetch one saved product with its screens and whether a session is stored. Use when you need the product\'s base URL or to check that a sign-in exists before recording. Required: environment_id. Returns: the environment plus { screens }.',
    { environment_id: z.string().describe('Environment id, e.g. env_…') },
    async (args) => getEnvironment(auth, args.environment_id)
  );

  register(
    server,
    'verify_environment',
    'Structurally check that the stored sign-in for a product is present and valid without launching a browser. Use before a recording run against a signed-in product to fail fast. Required: environment_id. Returns: { ok, hasSession, ... } describing the stored session.',
    { environment_id: z.string().describe('Environment id to verify.') },
    async (args) => verifyEnvironment(auth, args.environment_id)
  );

  // --------------------------------------------------------------- graph --
  register(
    server,
    'list_graph_flows',
    'List every flow in a product\'s Product Graph with status (fresh/stale/draft), step count and dependent article/guide counts. Use to find a flow id for write-article/fix-stale-flow or to audit staleness. Required: environment_id. Returns: array of flow views.',
    { environment_id: z.string().describe('Saved product id whose flows to list.') },
    async (args) => listFlows(auth, args.environment_id)
  );

  register(
    server,
    'get_graph_flow',
    'Fetch one Product Graph flow with its ordered steps, screens and the articles/guides generated from it. Use before writing documentation or diagnosing a drifted UI. Required: environment_id and flow_id. Returns: { flow, steps, screens, articles, guides }.',
    {
      environment_id: z.string().describe('Saved product that owns the flow.'),
      flow_id: z.string().describe('Flow id, e.g. flw_…')
    },
    async (args) => getFlow(auth, args.environment_id, args.flow_id)
  );

  register(
    server,
    'reverify_flow',
    'Re-check a flow against the live product without recording: marks it stale and flags dependent articles when the UI drifted. Use after a product deploy or before regenerating docs. Required: environment_id and flow_id. Returns the reverify result including whether the flow changed.',
    {
      environment_id: z.string().describe('Saved product that owns the flow.'),
      flow_id: z.string().describe('Flow id to re-check.')
    },
    async (args) => reverifyFlow(auth, args.environment_id, args.flow_id)
  );

  // ------------------------------------------------------------- domains --
  register(
    server,
    'attest_domain',
    'Confirm once that you are allowed to record a host, clearing DOMAIN_AUTHORIZATION_REQUIRED for future demos. Use only after the operator confirms ownership/permission. Required: host; optional authorized (default true). Returns: { ok, host, attestedAt }.',
    {
      host: z.string().describe('e.g. app.example.com'),
      authorized: z.boolean().optional().describe('Defaults to true; send false to withdraw confirmation.')
    },
    async (args) => attestDomain(auth, { host: args.host, authorized: args.authorized })
  );

  register(
    server,
    'list_domains',
    'List domains this workspace has attested or DNS/file-verified, with timestamps. Use to check whether a host still needs authorization before recording. Args: none. Returns an array of domain records.',
    {},
    async () => listDomains(auth)
  );

  // ------------------------------------------------------------ articles --
  register(
    server,
    'create_article_from_flow',
    'Generate a step-by-step article from a Product Graph flow, in help_center or internal_training channel. Use when the user asks for documentation of a recorded flow. Required: flow_id and channel; optional environment_id (cross-check only). Returns the draft article with title, excerpt, Markdown body and stale flag.',
    {
      flow_id: z.string().describe('Flow id to document, e.g. flw_…'),
      channel: z.enum(['help_center', 'internal_training']).describe('Audience for the article.'),
      environment_id: z.string().optional().describe('Optional cross-check that the flow belongs to this product.')
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
    'List articles in this workspace, newest first, optionally filtered by channel or status. Use to find an article id before get_article/update_article/publish_article, or to audit drafts. Args: limit optional (1–100, default 50), channel optional, status optional. Returns: array of article views with stale flags.',
    {
      limit: z.number().int().min(1).max(100).optional().describe('Max articles, default 50.'),
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
    'Fetch one article with its full Markdown body, excerpt, status, published URL and whether its source flow has gone stale. Use before editing or publishing. Required: article_id. Returns: the article view.',
    { article_id: z.string().describe('Article id, e.g. art_…') },
    async (args) => getArticle(auth, args.article_id)
  );

  register(
    server,
    'update_article',
    'Edit an article in place: title, excerpt, Markdown body, channel or status. Use to polish a generated draft before publishing. Required: article_id; optional title, excerpt, body_md, channel, status. Returns the updated article view.',
    {
      article_id: z.string().describe('Article id to edit.'),
      title: z.string().optional(),
      excerpt: z.string().optional(),
      body_md: z.string().optional().describe('Full replacement Markdown body.'),
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
    'Publish an article: sets status "published" and records its public URL (helpdesk sync happens server-side when configured). Use only after the user approves the draft. Required: article_id. Returns the published article; unpublish_article reverses it.',
    { article_id: z.string().describe('Article id to publish.') },
    async (args) => publishArticle(auth, args.article_id)
  );

  // ------------------------------------------------------------- presets --
  register(
    server,
    'list_recording_presets',
    'List saved recording presets plus the narration voices this build supports (with language and provider). Use to pick fps/zoom/voice values or a preset id for create_demo. Args: none. Returns: { presets, voices, defaultVoice }.',
    {},
    async () => ({
      presets: listPresets(auth),
      ...listVoices()
    })
  );

  // -------------------------------------------------------- integrations --
  register(
    server,
    'list_integrations',
    'List helpdesk/chat/webhook integrations and whether each is configured. Use to check whether publishing an article will sync anywhere or whether demo events will fire externally. Args: none. Returns an array of integrations with configured flags.',
    {},
    async () => listIntegrations(auth)
  );

  // Workspace + keys are useful for agents debugging auth.
  register(
    server,
    'get_workspace',
    'Return workspace identity, plan limits and lifetime usage counters (demos, environments, flows, articles, guides, credits). Use when an agent needs to reason about plan capacity; for current-month credits call get_usage. Args: none. Returns the workspace view.',
    {},
    async () => getWorkspace(auth)
  );

  register(
    server,
    'list_api_keys',
    'List API keys for this workspace by prefix, name and last-used time (plaintext is never stored or returned). Use only to diagnose which key an agent is using; it cannot mint or revoke keys over MCP. Args: none. Returns an array of key records.',
    {},
    async () => listApiKeys(auth)
  );

  // New v0.2 tools (health, usage, outputs, sharing, batches, guide publish).
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
