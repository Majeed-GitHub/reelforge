import type { FastifyInstance } from 'fastify';
import { handleMcpRequest } from '../mcp.ts';

export default async function mcpRoutes(app: FastifyInstance): Promise<void> {
  // Streamable HTTP MCP. Auth is the same X-API-Key/Bearer lookup as REST.
  app.post('/api/mcp', async (request, reply) => {
    await handleMcpRequest(request, reply);
  });
}