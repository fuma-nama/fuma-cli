import type { Framework } from "@/constants";
import { SUPPORTED_FRAMEWORKS } from "@/constants";
import { transformRouteHandler } from "@/macros/route-handler.build";
import { resolveRouteFilePath } from "@/utils/framework";
import MagicString from "magic-string";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { expect, test } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(__dirname, "fixtures/route-handler");

type RouteHandlerMatrixCase = {
  id: string;
  route: string;
};

const ROUTE_HANDLER_MATRIX_CASES: RouteHandlerMatrixCase[] = [
  { id: "basic-handler", route: "api/posts/[id]" },
  {
    id: "dynamic-params",
    route: "api/items/[id]/[...rest]",
  },
  { id: "get-only", route: "api/x" },
  { id: "noop-no-import", route: "api/x" },
  { id: "noop-import-only", route: "api/x" },
];

export interface BuildRouteHandlerFileOptions {
  route: string;
  /** Resolved absolute path for the emitted route module (used for `lang` / parse filename). */
  routeFilePath: string;
  framework: Framework;
  /** Source text (registry component output or app source) containing a `$routeHandler` call. */
  compiledContent: string;
}

export function buildRouteHandlerFromString(options: BuildRouteHandlerFileOptions): string {
  const { route, routeFilePath, framework, compiledContent } = options;

  const lang = path.extname(routeFilePath) === ".tsx" ? "tsx" : "ts";
  const result = parseSync(routeFilePath, compiledContent, { lang, astType: "ts" });
  if (result.errors.length > 0) {
    throw new Error(
      `route-handler.build: failed to parse ${routeFilePath}:\n${result.errors.map((e) => e.message).join("\n")}`,
    );
  }

  const program = result.program;
  const s = new MagicString(options.compiledContent);
  transformRouteHandler(route, routeFilePath, framework, program, s);
  return s.toString();
}

for (const { id, route } of ROUTE_HANDLER_MATRIX_CASES) {
  test(id, async () => {
    const compiledContent = await fs.readFile(path.join(fixtureRoot, id, "input.ts"), "utf8");
    const out: string[] = [];

    for (const framework of SUPPORTED_FRAMEWORKS) {
      const routeFilePath = resolveRouteFilePath(route, framework);

      const code = buildRouteHandlerFromString({
        route,
        routeFilePath,
        framework,
        compiledContent,
      });
      out.push(`\`\`\`ts framework="${framework}" path="${routeFilePath}"\n${code}\n\`\`\``);
    }

    await expect(out.join("\n\n")).toMatchFileSnapshot(path.join(fixtureRoot, id, "out.md"));
  });
}
