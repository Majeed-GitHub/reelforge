import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../../../core/src/http.ts';
import { mimeForPath, verifyFileToken } from '../signing.ts';

/**
 * GET /api/files/:token
 *
 * Signed media: no API key (a `<video src>` cannot send headers), 1-hour TTL,
 * HMAC-SHA256 over the relative data path with the local secret. Range requests
 * are supported so browsers can seek in the MP4.
 */
async function serveSignedFile(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  const { token } = request.params as { token: string };
  const verified = verifyFileToken(token);
  if (!verified) {
    throw new ApiError('FORBIDDEN', 'This media link is invalid or has expired.', {
      action: 'refetch_demo',
      hint: 'Signed media URLs are valid for 1 hour — re-fetch the demo (or article) for a fresh URL.'
    });
  }
  if (!fs.existsSync(verified.absPath)) {
    throw new ApiError('NOT_FOUND', 'That media file is no longer on disk.', {
      action: 'refetch_demo',
      hint: 'The recording may have been deleted from data/.'
    });
  }

  const stat = fs.statSync(verified.absPath);
  reply.header('accept-ranges', 'bytes');
  reply.header('cache-control', 'private, max-age=600');
  reply.type(mimeForPath(verified.absPath));

  const range = typeof request.headers.range === 'string' ? request.headers.range : undefined;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size) {
        const clampedEnd = Math.min(end, stat.size - 1);
        reply.code(206);
        reply.header('content-range', `bytes ${start}-${clampedEnd}/${stat.size}`);
        reply.header('content-length', String(clampedEnd - start + 1));
        return reply.send(fs.createReadStream(verified.absPath, { start, end: clampedEnd }));
      }
    }
  }

  reply.header('content-length', String(stat.size));
  return reply.send(fs.createReadStream(verified.absPath));
}

export default async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/files/:token', { config: { public: true } }, serveSignedFile);
  // Alias without the /api prefix, for URLs copied out of an article.
  app.get('/files/:token', { config: { public: true } }, serveSignedFile);
}