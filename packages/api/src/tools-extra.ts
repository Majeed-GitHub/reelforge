import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from './auth.ts';
import { createLoginCode } from './services/environments.ts';
import { getGuide, listGuides, publishGuide, unpublishGuide } from './services/guides.ts';
import { getDefaultPreset } from './services/presets.ts';

/**
 * MCP tools beyond Director's published list: guides, login codes and the
 * default preset. Registered through the same helper as everything else, so
 * they reuse the REST service functions. Kept in their own module purely so
 * src/mcp.ts stays readable.
 */

export type RegisterTool = (
  server: McpServer,
  name: string,
  description: string,
  shape: Record<string, z.ZodTypeAny>,
  execute: (args: Record<string, any>) => Promise<unknown> | unknown
) => void;

export function attachExtraTools(server: McpServer, auth: AuthContext, register: RegisterTool): void {
  register(
    server,
    'list_guides',
    'In-app guides for this workspace (draft or live), with their embed keys.',
    { environment_id: z.string().optional() },
    async (args) => listGuides(auth, args.environment_id)
  );

  register(
    server,
    'get_guide',
    'One in-app guide with its steps.',
    { guide_id: z.string() },
    async (args) => getGuide(auth, args.guide_id)
  );

  register(
    server,
    'publish_guide',
    'Make an in-app guide live so its embed key renders on customer pages.',
    { guide_id: z.string() },
    async (args) => publishGuide(auth, args.guide_id)
  );

  register(
    server,
    'unpublish_guide',
    'Move a live guide back to draft.',
    { guide_id: z.string() },
    async (args) => unpublishGuide(auth, args.guide_id)
  );

  register(
    server,
    'create_login_code',
    'Mint a single-use DIR-XXXX-XXXX-XXXX login code so the Director CLI can capture a session for an environment.',
    { environment_id: z.string() },
    async (args) => createLoginCode(auth, args.environment_id)
  );

  register(server, 'get_default_preset', 'The workspace default recording preset.', {}, async () =>
    getDefaultPreset(auth)
  );
}