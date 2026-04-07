```ts framework="next" path="app/api/x/route.ts"
export async function GET(request: Request, ctx: RouteContext<"/api/x">) {
  return new Response('ok');
}
```

```ts framework="waku" path="pages/_api/api/x.ts"
import type { ApiContext } from 'waku/router';

export async function GET(request: Request, context: ApiContext<"/api/x">) {
  return new Response('ok');
}
```

```ts framework="react-router" path="app/routes/api/x.ts"
import type { Route } from './+types/x';

export async function loader(args: Route.LoaderArgs) {
  const request = args.request;
  return new Response('ok');
}
```

```ts framework="tanstack-start" path="routes/api.x.ts"
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute("/api/x")({
  server: {
    handlers: {
      GET: async (ctx) => {
        const request = ctx.request;
        return new Response('ok');
      },
    },
  },
});
```

```ts framework="none" path="app/api/x/route.ts"
export async function GET(request: Request) {
  return new Response('ok');
}
```