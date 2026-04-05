import path from "node:path";
import fs from "node:fs/promises";
import { typescriptExtensions } from "@/constants";
import { toImportSpecifier, transformSpecifiers } from "@/utils/ast";
import type { File } from "@/registry/schema";
import type { RegistryConnector } from "@/registry/connector";
import { createDeps } from "@/registry/installer/dep-manager";
import { parse } from "oxc-parser";
import MagicString from "magic-string";
import { decodeImport, getComponentFileId } from "../protocols/import";
import type { Awaitable } from "@/types";
import { transformRouteHandler } from "@/macros/route-handler.build";
import {
  addReactRouterRouteToFile,
  resolveReactRouterRoute,
  resolveRouteFilePath,
} from "@/utils/framework";
import { DownloadedComponent, DownloadManager } from "./download-manager";
import { defaultIO, IOInterface } from "./io";

export interface TransformContext extends InstallContext {
  file: File;
  filePath: string;
  component: DownloadedComponent;
  installer: ComponentInstaller;
}

export interface InstallContext {
  /** all installed files, reduce unnecessary file writes */
  _installedFilePaths: Set<string>;

  dependencies: Record<string, string | null>;
  devDependencies: Record<string, string | null>;

  importLookup: Map<string, File>;
  /** full variables of the current component. */
  $variables: Record<string, unknown>;
  /** the last item is always the current component. */
  stack: DownloadedComponent[];
}

export interface DownloadContext {
  name: string;
  subRegistry?: string;
  connector: RegistryConnector;
  manager: DownloadManager;
}

export interface InstallerPlugin {
  transform?: (file: string, context: TransformContext) => Awaitable<string>;
  transformImport?: (specifier: string, context: TransformContext) => string;

  /**
   * transform component before install
   */
  beforeInstall?: (
    comp: DownloadedComponent,
    context: InstallContext & { installer: ComponentInstaller },
  ) => Awaitable<DownloadedComponent | undefined>;

  beforeDownload?: (context: DownloadContext) => Awaitable<void>;

  afterDownload?: (
    result: DownloadedComponent,
    context: DownloadContext,
  ) => Awaitable<DownloadedComponent | undefined>;
}

export interface ComponentInstallerOptions {
  plugins?: InstallerPlugin[];
  cwd?: string;
  io?: IOInterface;

  framework: "react-router" | "next" | "waku" | "tanstack-start";
  outDir: Record<"base" | "components" | "lib" | "css" | "ui" | "layout", string>;
}

export class ComponentInstaller {
  private readonly cwd: string;
  private readonly downloader: DownloadManager;
  private readonly io: IOInterface;

  constructor(
    private readonly connector: RegistryConnector,
    private readonly config: ComponentInstallerOptions,
  ) {
    this.cwd = config.cwd ?? process.cwd();
    this.io = config.io ?? defaultIO();
    this.downloader = new DownloadManager(config);
  }

  private async installComponent(comp: DownloadedComponent, ctx: InstallContext) {
    // avoid circular refs
    if (ctx.stack.indexOf(comp) !== ctx.stack.length - 1) return;

    const plugins = this.config.plugins ?? [];
    const pluginCtx = { installer: this, ...ctx };
    for (const plugin of plugins) {
      comp = (await plugin.beforeInstall?.(comp, pluginCtx)) ?? comp;
    }

    Object.assign(ctx.dependencies, comp.dependencies);
    Object.assign(ctx.devDependencies, comp.devDependencies);

    for (const file of comp.files) {
      const outPath = this.resolveOutputPath(file);
      if (ctx._installedFilePaths.has(outPath)) continue;
      ctx._installedFilePaths.add(outPath);

      const output = await this.transform(outPath, file, comp, ctx);

      const status = await fs
        .readFile(outPath)
        .then((res) => {
          if (res.toString().trim() === output.trim()) return "ignore";
          return "need-update";
        })
        .catch(() => "write");

      if (status === "ignore") continue;

      if (status === "need-update") {
        const override = await this.io.confirmFileOverride({ path: outPath });
        if (!override) continue;
      }

      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, output);
      this.io.onFileDownloaded({ path: outPath, file, component: comp });
    }

    for (const child of comp.$subComponents) {
      const stack = [...ctx.stack, child];
      const variables = { ...ctx.$variables };
      if (
        child.$registry.root.id !== comp.$registry.root.id ||
        child.$registry.subRegistry !== comp.$registry.subRegistry
      ) {
        const info = await child.$registry.root.fetchRegistryInfo(child.$registry.subRegistry);
        Object.assign(variables, info.variables);
      }
      Object.assign(variables, child.variables);

      await this.installComponent(child, { ...ctx, stack, $variables: variables });
    }
  }

  async install(name: string, subRegistry?: string) {
    const dependencies: Record<string, string | null> = {};
    const devDependencies: Record<string, string | null> = {};
    const downloaded = await this.downloader.download(this.connector, name, subRegistry);

    const allComponents = new Set<DownloadedComponent>();
    function scan(comp: DownloadedComponent) {
      if (allComponents.has(comp)) return;

      allComponents.add(comp);
      for (const child of comp.$subComponents) scan(child);
    }

    scan(downloaded);

    const importLookup = new Map<string, File>();
    for (const comp of allComponents) {
      for (const file of comp.files) {
        importLookup.set(getComponentFileId(file), file);
      }
    }

    const info = await downloaded.$registry.root.fetchRegistryInfo();
    await this.installComponent(downloaded, {
      _installedFilePaths: new Set(),
      dependencies,
      devDependencies,
      importLookup,
      $variables: { ...info.env, ...downloaded.variables },
      stack: [downloaded],
    });

    return {
      deps: () => {
        return createDeps(this.cwd, dependencies, devDependencies);
      },
    };
  }

  private async transform(
    filePath: string,
    file: File,
    component: DownloadedComponent,
    ctx: InstallContext,
  ): Promise<string> {
    const plugins = this.config.plugins ?? [];
    const transformCtx: TransformContext = { installer: this, file, filePath, component, ...ctx };
    let transformed = typescriptExtensions.includes(path.extname(filePath))
      ? await this.defaultTransform(file.content, transformCtx)
      : file.content;

    for (const plugin of plugins) {
      if (plugin.transform) {
        transformed = await plugin.transform(transformed, transformCtx);
      }
    }

    return transformed;
  }

  private async defaultTransform(content: string, ctx: TransformContext) {
    const { file, importLookup, filePath } = ctx;
    const config = this.config;
    const plugins = this.config.plugins ?? [];
    const parsed = await parse(filePath, content);
    const s = new MagicString(content);

    transformSpecifiers(parsed.program, s, (specifier) => {
      for (const plugin of plugins) {
        if (plugin.transformImport) {
          specifier = plugin.transformImport(specifier, ctx);
        }
      }

      const decoded = decodeImport(specifier);
      if (decoded.type === "local") {
        if (!importLookup.has(decoded.fileId)) {
          this.io.onWarn(`cannot find the referenced file of ${specifier}`);
          return specifier;
        }

        return toImportSpecifier(filePath, this.resolveOutputPath(importLookup.get(specifier)!));
      }

      return decoded.specifier;
    });

    if (file.type === "route-handler") {
      transformRouteHandler(file.route, filePath, config.framework, parsed.program, s);

      if (config.framework === "react-router") {
        const routesFile = path.join(this.cwd, "app/routes.ts");
        const content = await fs
          .readFile(routesFile, "utf-8")
          .then((res) => res.toString())
          .catch(() => null);

        if (content)
          await addReactRouterRouteToFile(routesFile, content, {
            path: resolveReactRouterRoute(file.route),
            module: path.relative(path.dirname(routesFile), filePath),
          });
      }
    }

    return s.toString();
  }

  private resolveOutputPath(file: File): string {
    const config = this.config;
    if (file.type === "route-handler") {
      const rel = resolveRouteFilePath(file.route, config.framework, "ts");
      return path.resolve(this.cwd, config.outDir.base, rel);
    }

    const dir = config.outDir[file.type];
    if (file.target) {
      return path.resolve(this.cwd, config.outDir.base, file.target.replace("<dir>", dir));
    }

    return path.resolve(this.cwd, config.outDir.base, dir, path.basename(file.path));
  }
}
