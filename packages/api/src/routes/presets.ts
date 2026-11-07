import type { FastifyInstance } from 'fastify';
import { ok } from '../../../core/src/http.ts';
import { authOf } from '../auth.ts';
import { presetCreateSchema } from '../schemas.ts';
import { createPreset, getDefaultPreset, listPresets, listVoices } from '../services/presets.ts';
import { parseBody } from '../util.ts';

export default async function presetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/presets', async (request) => {
    const auth = authOf(request);
    return ok(listPresets(auth), 'OK');
  });

  app.get('/api/presets/default', async (request) => {
    const auth = authOf(request);
    return ok(getDefaultPreset(auth), 'OK');
  });

  app.get('/api/presets/voices', async () => ok(listVoices(), 'OK'));

  app.post('/api/presets', async (request) => {
    const auth = authOf(request);
    const body = parseBody(presetCreateSchema, request.body);
    return ok(createPreset(auth, body), 'Preset saved.');
  });
}