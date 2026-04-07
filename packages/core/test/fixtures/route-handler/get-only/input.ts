import { $routeHandler } from '@fumadocs/cli/registry/macros/route-handler';

export const handler = $routeHandler(
  { methods: ['GET'], params: [] },
  async () => new Response('ok'),
);
