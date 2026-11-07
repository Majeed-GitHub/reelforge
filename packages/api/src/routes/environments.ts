import type { FastifyInstance } from 'fastify';
import { ok } from '../../../core/src/http.ts';
import { authOf } from '../auth.ts';
import {
  environmentCreateSchema,
  environmentPatchSchema,
  sessionSchema
} from '../schemas.ts';
import {
  createEnvironment,
  createLoginCode,
  getEnvironment,
  listEnvironments,
  patchEnvironment,
  redeemLoginCodeSession,
  resolveLoginCode,
  setEnvironmentSession,
  verifyEnvironment
} from '../services/environments.ts';
import { parseBody } from '../util.ts';

export default async function environmentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/environments', async (request) => {
    const auth = authOf(request);
    const body = parseBody(environmentCreateSchema, request.body);
    return ok(createEnvironment(auth, body), 'Environment saved.');
  });

  app.get('/api/environments', async (request) => {
    const auth = authOf(request);
    return ok(listEnvironments(auth), 'OK');
  });

  app.get('/api/environments/:id', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    return ok(getEnvironment(auth, id), 'OK');
  });

  app.patch('/api/environments/:id', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const body = parseBody(environmentPatchSchema, request.body);
    return ok(patchEnvironment(auth, id, body), 'Environment updated.');
  });

  app.post('/api/environments/:id/session', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const body = parseBody(sessionSchema, request.body);
    return ok(setEnvironmentSession(auth, id, body), 'Session captured and encrypted at rest.');
  });

  app.post('/api/environments/:id/verify', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    return ok(verifyEnvironment(auth, id), 'Checked stored sign-in (no browser launched).');
  });

  app.post('/api/environments/:id/login-code', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    return ok(createLoginCode(auth, id), 'Login code created — single use, expires in 30 minutes.');
  });

  // ---- Director CLI capture flow (public: the code is the credential) ----

  app.post('/api/environments/by-code/:code', { config: { public: true } }, async (request) => {
    const { code } = request.params as { code: string };
    return ok(resolveLoginCode(code), 'Login code resolved.');
  });

  app.post('/api/environments/by-code/:code/session', { config: { public: true } }, async (request) => {
    const { code } = request.params as { code: string };
    const body = parseBody(sessionSchema, request.body);
    return ok(redeemLoginCodeSession(code, body), 'Session attached to the environment; code burned.');
  });

  // GET variants, because the CLI probes both verbs.
  app.get('/api/environments/by-code/:code', { config: { public: true } }, async (request) => {
    const { code } = request.params as { code: string };
    return ok(resolveLoginCode(code), 'Login code resolved.');
  });
}