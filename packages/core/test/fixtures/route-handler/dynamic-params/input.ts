import { $routeHandler } from '@fumadocs/cli/registry/macros/route-handler';
export const h = $routeHandler(
  { methods: ['GET'], params: ['id'], catchAll: 'rest' },
  async (request, p) => Response.json({ request, p }),
);
