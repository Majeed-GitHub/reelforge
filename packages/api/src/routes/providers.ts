/**
 * BYOK provider routes.
 *
 *   GET    /api/providers                  catalog + what is in effect
 *   GET    /api/providers/models?provider= live model discovery (never a key)
 *   POST   /api/providers                  save provider/model/baseUrl/key
 *   POST   /api/providers/test             probe the provider ("say ok")
 *   DELETE /api/providers                  clear the workspace override
 *
 * Every route requires the normal `X-API-Key` (attachAuth hooks /api/*).
 * Responses use Director's `{ message, data }` envelope; validation failures use
 * `VALIDATION_ERROR`. Stored keys are never returned — only `keyHint`.
 *
 * The lead registers this file in server.ts with:
 *   import providerRoutes from './routes/providers.ts';
 *   await app.register(providerRoutes);
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, ok } from '../../../core/src/http.ts';
import { authOf } from '../auth.ts';
import {
  clearProviders,
  listProviderModels,
  providerStatusWithDetection,
  runProviderTest,
  saveProviders
} from '../services/providers.ts';
import { parseBody } from '../util.ts';

const llmInputSchema = z
  .object({
    providerId: z.string().trim().min(1).max(40),
    apiKey: z.string().max(4096).optional(),
    model: z.string().max(200).optional(),
    baseUrl: z.string().max(2048).optional()
  })
  .strict();

const ttsInputSchema = z
  .object({
    providerId: z.string().trim().min(1).max(40),
    voice: z.string().max(200).optional()
  })
  .strict();

const saveSchema = z
  .object({
    llm: llmInputSchema.optional(),
    tts: ttsInputSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.llm && !value.tts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'send `llm` and/or `tts`'
      });
    }
  });

const testSchema = z
  .object({
    providerId: z.string().trim().min(1).max(40),
    apiKey: z.string().max(4096).optional(),
    baseUrl: z.string().max(2048).optional(),
    model: z.string().max(200).optional()
  })
  .strict();

export async function registerProviderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/providers', async (request) => {
    const auth = authOf(request);
    return ok(await providerStatusWithDetection(auth), 'OK');
  });

  app.post('/api/providers', async (request) => {
    const auth = authOf(request);
    const body = parseBody(saveSchema, request.body ?? {});
    saveProviders(auth, body);
    return ok(
      await providerStatusWithDetection(auth),
      'Provider settings saved. Keys are encrypted at rest and never returned.'
    );
  });

  app.delete('/api/providers', async (request) => {
    const auth = authOf(request);
    clearProviders(auth);
    return ok(
      await providerStatusWithDetection(auth),
      'Workspace provider override cleared — environment variables still apply.'
    );
  });

  app.get('/api/providers/models', async (request) => {
    const auth = authOf(request);
    const query = (request.query ?? {}) as { provider?: string; baseUrl?: string };
    const providerId = (query.provider ?? '').trim();
    if (!providerId) {
      throw new ApiError('VALIDATION_ERROR', 'The `provider` query parameter is required.', {
        action: 'fix_request',
        hint: 'GET /api/providers/models?provider=gmi (optionally &baseUrl=https://gateway.example/v1).'
      });
    }
    const result = await listProviderModels(auth, providerId, query.baseUrl);
    return ok({ models: result.models, source: result.source }, result.message);
  });

  app.post('/api/providers/test', async (request) => {
    const auth = authOf(request);
    const body = parseBody(testSchema, request.body ?? {});
    const result = await runProviderTest(auth, body);
    return ok(
      result,
      result.ok
        ? `Connection OK in ${result.latencyMs}ms (${result.model}).`
        : `Connection failed: ${result.error?.message ?? 'unknown error'}`
    );
  });
}

export default registerProviderRoutes;
