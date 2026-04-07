```ts framework="next" path="app/api/items/[id]/[...rest]/route.ts"
export async function GET(request: Request, ctx: RouteContext<"/api/items/[id]/[...rest]">) {
  const p = await ctx.params;
  return Response.json({ request, p });
}
```

```ts framework="waku" path="pages/_api/api/items/[id]/[...rest].ts"
import type { ApiContext } from 'waku/router';
export async function GET(request: Request, context: ApiContext<"/api/items/[id]/[...rest]">) {
  const p = context.params;
  return Response.json({ request, p });
}
```

```ts framework="react-router" path="app/routes/api/items/$id/all.ts"
import type { Route } from './+types/all';
export async function loader(args: Route.LoaderArgs) {
  const request = args.request;
  const p = {
    id: args.params.id,
    rest: args.params['*']
  };
  return Response.json({ request, p });
}
```

```ts framework="tanstack-start" path="routes/api.items.$id.$.ts"
import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute("/api/items/$id/$")({
  server: {
    handlers: {
      GET: async (ctx) => {
        const request = ctx.request;
        const p = {
          id: ctx.params.id,
          rest: ctx.params._splat
        };
        return Response.json({ request, p });
      },
    },
  },
});
```

```ts framework="none" path="app/api/items/[id]/[...rest]/route.ts"
export async function GET(request: Request, p: { id: string; rest?: string[]; }) {
  return Response.json({ request, p });
}
```