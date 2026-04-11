import path from "node:path";
import fs from "node:fs/promises";
import { type Framework, JS_LANGS } from "@/constants";
import { toImportSpecifier, transformSpecifiers } from "@/utils/ast";
import type { File } from "@/registry/schema";
import type { RegistryConnector } from "@/registry/connector";
import { createDeps } from "@/registry/installer/dep-manager";
import { parseSync } from "oxc-parser";
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
import { defaultIO, type IOInterface } from "./io";
import { existsSync } from "node:fs";
import { detectFramework } from "@/detect";

export interface TransformContext extends InstallContext {
  file: File;
  filePath: string;
  component: DownloadedComponent;
  installer: ComponentInstaller;
}

export interface InstallContext {
  dependencies: Record<string, string | null>;
  devDependencies: Record<string, string | null>;
  /** full variables of the current component. */
  $variables: Record<string, unknown>;
  /** the last item is always the current component. */
  stack: DownloadedComponent[];

  _fileIdToFile: Map<string, File>;
  /** all installed files, reduce unnecessary file writes */
  _installedFilePaths: Set<string>;
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
  /**
   * The preferred framework, installer will generate code based on the framework.
   *
   * If not specified, it detects from user's workspace.
   *
   * If the target framework isn't supported, it's recommended to use `none` for framework-agnostic code.
   */
  framework?: Framework;
  outDir?: Partial<OutputDestinations>;
}

type OutputDestinations = Record<"base" | "components" | "lib" | "css" | "ui" | "layout", string>;

export class ComponentInstaller {
  private readonly cwd: string;
  private readonly downloader: DownloadManager;
  private readonly io: IOInterface;
  private readonly destinations: OutputDestinations;
  private _framework: Awaitable<Framework> | undefined;

  constructor(
    protected readonly connector: RegistryConnector,
    private readonly config: ComponentInstallerOptions = {},
  ) {
    this.cwd = config.cwd ?? process.cwd();
    this.io = config.io ?? defaultIO();
    this.downloader = new DownloadManager(config);

    const outDir = config.outDir ?? {};
    this.destinations = {
      base: outDir.base ?? (existsSync(path.join(this.cwd, "./src")) ? "src" : ""),
      components: outDir.components ?? "components",
      css: outDir.css ?? "css",
      layout: outDir.layout ?? "components/layouts",
      lib: outDir.lib ?? "lib",
      ui: outDir.ui ?? "components/ui",
    };
  }

  private async installComponent(comp: DownloadedComponent, ctx: InstallContext) {
    // avoid circular refs
    if (ctx.stack.indexOf(comp) !== ctx.stack.length - 1) return;

    const framework = await this.getFramework();
    const pluginCtx = { installer: this, ...ctx };
    for (const plugin of this.config.plugins ?? []) {
      comp = (await plugin.beforeInstall?.(comp, pluginCtx)) ?? comp;
    }

    Object.assign(ctx.dependencies, comp.dependencies);
    Object.assign(ctx.devDependencies, comp.devDependencies);

    for (const file of comp.files) {
      const outPath = this.resolveOutputPath(framework, file);
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
    const importLookup = new Map<string, File>();

    function scan(comp: DownloadedComponent, visited: Set<DownloadedComponent> = new Set()) {
      if (visited.has(comp)) return;

      for (const file of comp.files) {
        importLookup.set(getComponentFileId(file), file);
      }

      visited.add(comp);
      for (const child of comp.$subComponents) scan(child, visited);
    }

    scan(downloaded);
    const info = await downloaded.$registry.root.fetchRegistryInfo();
    await this.installComponent(downloaded, {
      _installedFilePaths: new Set(),
      dependencies,
      devDependencies,
      _fileIdToFile: importLookup,
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
    let transformed = await this.defaultTransform(file.content, transformCtx);

    for (const plugin of plugins) {
      if (plugin.transform) {
        transformed = await plugin.transform(transformed, transformCtx);
      }
    }

    return transformed;
  }

  private async defaultTransform(content: string, ctx: TransformContext) {
    const { file, _fileIdToFile, filePath } = ctx;
    const config = this.config;
    const ext = path.extname(filePath);
    const lang = JS_LANGS.find((lang) => `.${lang}` === ext);
    if (!lang) return content;

    const parsed = parseSync(filePath, content, {
      lang,
    });
    const s = new MagicString(content);
    const framework = await this.getFramework();

    transformSpecifiers(parsed.program, s, (specifier) => {
      for (const plugin of config.plugins ?? []) {
        if (plugin.transformImport) {
          specifier = plugin.transformImport(specifier, ctx);
        }
      }

      const decoded = decodeImport(specifier);
      if (decoded.type === "local") {
        const resolvedFile = _fileIdToFile.get(decoded.fileId);
        if (!resolvedFile) {
          this.io.onWarn(`cannot find the referenced file of ${specifier}`);
          return specifier;
        }

        return toImportSpecifier(filePath, this.resolveOutputPath(framework, resolvedFile));
      }

      return decoded.specifier;
    });

    if (file.type === "route-handler") {
      transformRouteHandler(file.route, filePath, framework, parsed.program, s);

      if (framework === "react-router") {
        const routesFile = path.join(this.cwd, "app/routes.ts");
        const content = await fs.readFile(routesFile, "utf-8").catch(() => null);

        if (content) {
          await addReactRouterRouteToFile(routesFile, content, {
            path: resolveReactRouterRoute(file.route),
            module: path.relative(path.dirname(routesFile), filePath),
          });
        }
      }
    }

    return s.toString();
  }

  private async getFramework() {
    if (this._framework) return this._framework;

    return (this._framework = this.config.framework ?? detectFramework(this.cwd));
  }

  private resolveOutputPath(framework: Framework, file: File): string {
    if (file.type === "route-handler") {
      const rel = resolveRouteFilePath(file.route, framework, "ts");
      return path.resolve(this.cwd, this.destinations.base, rel);
    }

    const dir = this.destinations[file.type];
    if (file.target) {
      return path.resolve(this.cwd, this.destinations.base, file.target.replace("<dir>", dir));
    }

    return path.resolve(this.cwd, this.destinations.base, dir, path.basename(file.path));
  }
}

export type { IOInterface } from "./io";
export type { DownloadedComponent } from "./download-manager";
