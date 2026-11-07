import type { FastifyInstance } from 'fastify';
import { ok } from '../../../core/src/http.ts';
import type { AuthContext } from '../auth.ts';
import { authOf } from '../auth.ts';
import { guidePatchSchema, guideReportSchema } from '../schemas.ts';
import {
  getGuide,
  getGuideByEmbedKey,
  listGuides,
  patchGuide,
  publishGuide,
  reportGuideSkip,
  unpublishGuide
} from '../services/guides.ts';
import { parseBody } from '../util.ts';

export default async function guideRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/guides', async (request) => {
    const auth = authOf(request);
    const query = request.query as Record<string, unknown>;
    return ok(listGuides(auth, typeof query.environmentId === 'string' ? query.environmentId : undefined), 'OK');
  });

  /**
   * PUBLIC: the embed widget fetches this from a customer's page. The embed key
   * is the credential; it is unguessable and read-only.
   */
  app.get('/api/guides/embed/:embedKey', { config: { public: true } }, async (request) => {
    const { embedKey } = request.params as { embedKey: string };
    return ok(getGuideByEmbedKey(embedKey), 'OK');
  });

  app.get('/api/guides/:id', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    return ok(getGuide(auth, id), 'OK');
  });

  app.patch('/api/guides/:id', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const body = parseBody(guidePatchSchema, request.body);
    return ok(patchGuide(auth, id, body), 'Guide updated.');
  });

  app.post('/api/guides/:id/publish', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    return ok(publishGuide(auth, id), 'Guide is live.');
  });

  app.post('/api/guides/:id/unpublish', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    return ok(unpublishGuide(auth, id), 'Guide moved back to draft.');
  });

  /** PUBLIC: the widget reports skipped steps (no API key on third-party pages). */
  app.post('/api/guides/:id/report', { config: { public: true } }, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(guideReportSchema, request.body ?? {});
    return ok(reportGuideSkip(id, body), 'Report recorded.');
  });
}

export type { AuthContext };