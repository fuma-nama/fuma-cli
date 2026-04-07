```ts framework="next" path="app/api/posts/[id]/route.ts"
export async function GET(req: Request, ctx: RouteContext<"/api/posts/[id]">) {
  const p = await ctx.params;
  return Response.json({ id: p.id });
}

export async function POST(req: Request, ctx: RouteContext<"/api/posts/[id]">) {
  const p = await ctx.params;
  return Response.json({ id: p.id });
}
```

```ts framework="waku" path="pages/_api/api/posts/[id].ts"
import type { ApiContext } from 'waku/router';

export async function GET(req: Request, context: ApiContext<"/api/posts/[id]">) {
  const p = context.params;
  return Response.json({ id: p.id });
}

export async function POST(req: Request, context: ApiContext<"/api/posts/[id]">) {
  const p = context.params;
  return Response.json({ id: p.id });
}
```

```ts framework="react-router" path="app/routes/api/posts/$id.ts"
import type { Route } from './+types/$id';

export async function loader(args: Route.LoaderArgs) {
  const req = args.request;
  const p = {
    id: args.params.id
  };
  return Response.json({ id: p.id });
}

export async function action(args: Route.ActionArgs) {
  const req = args.request;
  const p = {
    id: args.params.id
  };
  return Response.json({ id: p.id });
}
```

```ts framework="tanstack-start" path="routes/api.posts.$id.ts"
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute("/api/posts/$id")({
  server: {
    handlers: {
      GET: async (ctx) => {
        const req = ctx.request;
        const p = {
          id: ctx.params.id
        };
        return Response.json({ id: p.id });
      },
      POST: async (ctx) => {
        const req = ctx.request;
        const p = {
          id: ctx.params.id
        };
        return Response.json({ id: p.id });
      },
    },
  },
});
```

```ts framework="none" path="app/api/posts/[id]/route.ts"
export async function GET(req: Request, p: { id: string; }) {
  return Response.json({ id: p.id });
}

export async function POST(req: Request, p: { id: string; }) {
  return Response.json({ id: p.id });
}
```