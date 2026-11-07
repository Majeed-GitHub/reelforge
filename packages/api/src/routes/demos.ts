import type { FastifyInstance } from 'fastify';
import { ok } from '../../../core/src/http.ts';
import { authOf } from '../auth.ts';
import { demoCreateSchema, demoAnswerSchema } from '../schemas.ts';
import {
  answerQuestion,
  cancelDemo,
  createDemo,
  getDemo,
  getTranscript,
  listDemos
} from '../services/demos.ts';
import { intParam, parseBody } from '../util.ts';

export default async function demoRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/demos', async (request) => {
    const auth = authOf(request);
    const body = parseBody(demoCreateSchema, request.body);
    const created = createDemo(auth, body);
    return ok(created, 'Demo queued.');
  });

  app.get('/api/demos', async (request) => {
    const auth = authOf(request);
    const query = request.query as Record<string, unknown>;
    const limit = intParam(query.limit, 20, 100);
    return ok(listDemos(auth, limit), 'OK');
  });

  app.get('/api/demos/:id', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    return ok(getDemo(auth, id), 'OK');
  });

  app.get('/api/demos/:id/transcript', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    return ok(getTranscript(auth, id), 'OK');
  });

  app.post('/api/demos/:id/question/answer', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const body = parseBody(demoAnswerSchema, request.body);
    return ok(answerQuestion(auth, id, body.optionId), 'Answer recorded.');
  });

  app.post('/api/demos/:id/cancel', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const result = await cancelDemo(auth, id);
    return ok(result, result.cancelled ? 'Demo cancelled.' : 'Demo was already cancelled.');
  });
}