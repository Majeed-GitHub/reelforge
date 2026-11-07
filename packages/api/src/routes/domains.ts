import type { FastifyInstance } from 'fastify';
import { ok } from '../../../core/src/http.ts';
import { authOf } from '../auth.ts';
import { domainAttestSchema, domainCheckSchema, domainVerificationSchema } from '../schemas.ts';
import {
  attestDomain,
  checkDomainVerification,
  listDomains,
  startDomainVerification
} from '../services/domains.ts';
import { parseBody } from '../util.ts';

export default async function domainRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/domains', async (request) => {
    const auth = authOf(request);
    return ok(listDomains(auth), 'OK');
  });

  app.post('/api/domains/attest', async (request) => {
    const auth = authOf(request);
    const body = parseBody(domainAttestSchema, request.body);
    const host = body.host ?? body.domain ?? body.url;
    if (!host) {
      const { ApiError } = await import('../../../core/src/http.ts');
      throw new ApiError('VALIDATION_ERROR', 'A `host` is required.', {
        action: 'fix_request',
        hint: '{"host":"app.example.com","authorized":true}'
      });
    }
    return ok(attestDomain(auth, { host, authorized: body.authorized }), 'Domain attested.');
  });

  app.post('/api/domains/verification', async (request) => {
    const auth = authOf(request);
    const body = parseBody(domainVerificationSchema, request.body);
    return ok(startDomainVerification(auth, body), 'Publish the DNS record, then check it.');
  });

  app.post('/api/domains/verification/check', async (request) => {
    const auth = authOf(request);
    const body = parseBody(domainCheckSchema, request.body);
    const result = await checkDomainVerification(auth, body);
    return ok(result, result.verified ? 'Domain verified.' : 'Domain not verified yet.');
  });
}