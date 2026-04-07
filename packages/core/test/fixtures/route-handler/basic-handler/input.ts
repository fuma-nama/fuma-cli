import { $routeHandler } from '@fumadocs/cli/registry/macros/route-handler';

export const handler = $routeHandler(
  { methods: ['GET', 'POST'], params: ['id'] },
  async (req, p) => Response.json({ id: p.id }),
);
