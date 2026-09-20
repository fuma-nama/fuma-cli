import { $routeHandler } from "fuma-cli/macros/route-handler";
import { cn } from "./utils/cn";

export const handler = $routeHandler({ methods: ["POST"], params: [] }, async (req) => {
  return Response.json(cn(await req.text()));
});
