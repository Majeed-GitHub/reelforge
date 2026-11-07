import type { FastifyInstance } from 'fastify';
import { ok } from '../../../core/src/http.ts';
import { authOf } from '../auth.ts';
import { apiKeyCreateSchema } from '../schemas.ts';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/apikeys.ts';
import { getWorkspace } from '../services/workspace.ts';
import { listIntegrations } from '../services/integrations.ts';
import { parseBody } from '../util.ts';

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/workspace', async (request) => {
    const auth = authOf(request);
    return ok(getWorkspace(auth), 'OK');
  });

  app.get('/api/api-keys', async (request) => {
    const auth = authOf(request);
    return ok(listApiKeys(auth), 'OK');
  });

  app.post('/api/api-keys', async (request) => {
    const auth = authOf(request);
    const body = parseBody(apiKeyCreateSchema, request.body ?? {});
    const created = createApiKey(auth, body.name);
    return ok(created, 'API key created — copy it now, it is shown once.');
  });

  app.delete('/api/api-keys/:id', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    return ok(revokeApiKey(auth, id), 'API key revoked.');
  });

  app.get('/api/integrations', async (request) => {
    const auth = authOf(request);
    return ok(listIntegrations(auth), 'OK');
  });
}