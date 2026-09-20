import path from "node:path";
import fs from "node:fs/promises";
import type { InstallerPlugin } from "@/registry/installer";
import {
  addReactRouterRouteToFile,
  resolveReactRouterRoute,
  resolveRouteFilePath,
} from "@/utils/framework";

/**
 * Install `route-handler` files as routes of the consumer's framework.
 */
export function routeHandlerPlugin(): InstallerPlugin {
  return {
    name: "route-handler",
    async resolveId(file) {
      if (file.info.type !== "route-handler") return;
      const route = resolveRouteFilePath(file.info.route, await this.getFramework(), "ts");
      return { id: path.join(this.baseDir, route) };
    },
    async transform(code, file) {
      if (file.info.type !== "route-handler") return;
      const { buildRouteHandler } = await import("@/macros/route-handler.build");
      return buildRouteHandler(code, file.info.route, file.output, await this.getFramework());
    },
    async writeBundle(files) {
      if ((await this.getFramework()) !== "react-router") return;
      const routesFile = path.join(this.cwd, "app/routes.ts");

      for (const file of files) {
        if (file.info.type !== "route-handler") continue;
        const content = await fs.readFile(routesFile, "utf-8").catch(() => null);
        if (!content) return;

        await addReactRouterRouteToFile(routesFile, content, {
          path: resolveReactRouterRoute(file.info.route),
          module: path.relative(path.dirname(routesFile), file.output),
        });
      }
    },
  };
}
