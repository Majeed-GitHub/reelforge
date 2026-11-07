import type { FastifyInstance } from 'fastify';
import { ok } from '../../../core/src/http.ts';
import { authOf } from '../auth.ts';
import { articleFromFlowSchema, articlePatchSchema } from '../schemas.ts';
import {
  createArticleFromFlow,
  getArticle,
  listArticles,
  patchArticle,
  publishArticle,
  unpublishArticle
} from '../services/articles.ts';
import { listFlowOptions } from '../services/graph.ts';
import { intParam, parseBody } from '../util.ts';

export default async function articleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/articles', async (request) => {
    const auth = authOf(request);
    const query = request.query as Record<string, unknown>;
    return ok(
      listArticles(auth, {
        limit: intParam(query.limit, 50, 100),
        channel: query.channel === 'internal_training' ? 'internal_training' : query.channel === 'help_center' ? 'help_center' : undefined,
        status: query.status === 'published' ? 'published' : query.status === 'draft' ? 'draft' : undefined
      }),
      'OK'
    );
  });

  app.get('/api/articles/:id', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    return ok(getArticle(auth, id), 'OK');
  });

  app.patch('/api/articles/:id', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const body = parseBody(articlePatchSchema, request.body);
    return ok(patchArticle(auth, id, body), 'Article updated.');
  });

  app.post('/api/articles/from-flow', async (request) => {
    const auth = authOf(request);
    const body = parseBody(articleFromFlowSchema, request.body);
    return ok(createArticleFromFlow(auth, body), 'Article written from flow.');
  });

  app.post('/api/articles/:id/publish', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    return ok(publishArticle(auth, id), 'Article published.');
  });

  app.post('/api/articles/:id/unpublish', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    return ok(unpublishArticle(auth, id), 'Article unpublished.');
  });

  // Discoverable flow ids (nice for the dashboard's "write article" picker).
  app.get('/api/flows', async (request) => {
    const auth = authOf(request);
    return ok(listFlowOptions(auth), 'OK');
  });
}