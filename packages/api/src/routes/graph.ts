import type { FastifyInstance } from 'fastify';
import { ok } from '../../../core/src/http.ts';
import { authOf } from '../auth.ts';
import { reverifyFlow } from '../reverify.ts';
import { getFlow, listFlows } from '../services/graph.ts';

export default async function graphRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/environments/:id/graph/flows', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    return ok(listFlows(auth, id), 'OK');
  });

  app.get('/api/environments/:id/graph/flows/:flowId', async (request) => {
    const auth = authOf(request);
    const { id, flowId } = request.params as { id: string; flowId: string };
    return ok(getFlow(auth, id, flowId), 'OK');
  });

  app.post('/api/environments/:id/graph/flows/:flowId/reverify', async (request) => {
    const auth = authOf(request);
    const { id, flowId } = request.params as { id: string; flowId: string };
    const result = await reverifyFlow(auth, id, flowId);
    return ok(result, result.status === 'fresh' ? 'Flow is still fresh.' : 'Flow marked stale.');
  });
}