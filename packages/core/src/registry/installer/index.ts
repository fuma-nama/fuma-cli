import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { type Framework, JS_LANGS } from "@/constants";
import { decodeFileId, encodeFileId, type Manifest, type ManifestFile } from "@/registry/schema";
import type { RegistryConnector } from "@/registry/connector";
import { createDeps, type DependencyManager } from "@/registry/installer/dep-manager";
import type { Awaitable } from "@/types";
import { detectFramework } from "@/detect";
import { routeHandlerPlugin } from "@/macros/route-handler.plugin";

export interface LinkedFile {
  id: string;
  registry: string;
  /** path in registry */
  path: string;
  info: ManifestFile;
  /** absolute output path */
  output: string;
  /** imported from `output` instead of installed, e.g. the consumer already owns an equivalent */
  external: boolean;
}

export interface PlannedFile extends LinkedFile {
  content: string | Uint8Array;
  status: "create" | "overwrite" | "unchanged";
}

export interface InstallPlan {
  files: PlannedFile[];
  deps: () => Promise<DependencyManager>;
}

export interface InstallTarget {
  name: string;
  /** name of sub registry */
  registry?: string;
}

export interface PluginContext {
  cwd: string;
  /** absolute path of `outDir.base` */
  baseDir: string;
  getFramework: () => Promise<Framework>;
}

export interface InstallerPlugin {
  name: string;
  /** decide the output path of a file, an `external` file is imported from there instead of installed */
  resolveId?: (
    this: PluginContext,
    file: Omit<LinkedFile, "output" | "external">,
  ) => Awaitable<{ id: string; external?: boolean } | undefined>;
  /** executed after imports are linked */
  transform?: (
    this: PluginContext,
    code: string,
    file: LinkedFile,
  ) => Awaitable<string | undefined>;
  /** executed after files are written */
  writeBundle?: (this: PluginContext, files: PlannedFile[]) => Awaitable<void>;
}

export interface IOInterface {
  confirmFileOverride: (file: PlannedFile) => Awaitable<boolean>;
  onFileWritten: (file: PlannedFile) => void;
}

export interface ComponentInstallerOptions {
  plugins?: InstallerPlugin[];
  cwd?: string;
  io?: Partial<IOInterface>;
  /**
   * The preferred framework, installer will generate code based on the framework.
   *
   * If not specified, it detects from user's workspace.
   *
   * If the target framework isn't supported, it's recommended to use `none` for framework-agnostic code.
   */
  framework?: Framework;
  outDir?: Partial<OutputDestinations>;
  /** install files of another registry instead, as `{ [from]: to }`. Both must share the file structure */
  registryAliases?: Record<string, string>;
}

type OutputDestinations = Record<"base" | "components" | "lib" | "css" | "ui" | "layout", string>;

export class ComponentInstaller {
  private readonly cwd: string;
  private readonly io: IOInterface;
  private readonly destinations: OutputDestinations;
  private readonly plugins: InstallerPlugin[];
  private readonly context: PluginContext;
  private root: Promise<Manifest> | undefined;
  private readonly manifests = new Map<string, Promise<Manifest>>();
  private readonly linked = new Map<string, Promise<LinkedFile>>();

  constructor(
    protected readonly connector: RegistryConnector,
    private readonly config: ComponentInstallerOptions = {},
  ) {
    const cwd = (this.cwd = config.cwd ?? process.cwd());
    this.io = {
      confirmFileOverride: () => true,
      onFileWritten() {},
      ...config.io,
    };

    const outDir = config.outDir ?? {};
    this.destinations = {
      base: outDir.base ?? (existsSync(path.join(cwd, "./src")) ? "src" : ""),
      components: outDir.components ?? "components",
      css: outDir.css ?? "css",
      layout: outDir.layout ?? "components/layouts",
      lib: outDir.lib ?? "lib",
      ui: outDir.ui ?? "components/ui",
    };

    let framework: Promise<Framework> | undefined;
    this.plugins = [...(config.plugins ?? []), routeHandlerPlugin()];
    this.context = {
      cwd,
      baseDir: path.resolve(cwd, this.destinations.base),
      getFramework: () => (framework ??= Promise.resolve(config.framework ?? detectFramework(cwd))),
    };
  }

  /** @param registry - name of registry, the root registry if omitted */
  async fetchManifest(registry?: string): Promise<Manifest> {
    const root = (this.root ??= this.connector.fetchManifest());
    if (!registry || registry === (await root).name) return root;

    let manifest = this.manifests.get(registry);
    if (!manifest) {
      manifest = this.connector.fetchManifest(registry);
      this.manifests.set(registry, manifest);
    }
    return manifest;
  }

  /**
   * Link the components against consumer's codebase, nothing is written until `apply()`.
   */
  async plan(targets: InstallTarget[]): Promise<InstallPlan> {
    const stack: string[] = [];

    for (const target of targets) {
      const manifest = await this.fetchManifest(target.registry);
      const component = manifest.components.find((item) => item.name === target.name);
      if (!component) throw new Error(`component "${target.name}" not found`);
      for (const file of component.files) stack.push(encodeFileId(manifest.name, file));
    }

    // files reachable without going through a package import
    const closure = new Map<string, LinkedFile>();
    let id: string | undefined;
    while ((id = stack.pop())) {
      const file = await this.link(id);
      if (closure.has(file.id)) continue;
      closure.set(file.id, file);
      if (file.external || !file.info.imports) continue;

      for (const item of file.info.imports) {
        if (!item.package) stack.push(item.id);
      }
    }

    const dependencies: Record<string, string | null> = {};
    const devDependencies: Record<string, string | null> = {};
    const pending: Promise<PlannedFile>[] = [];
    for (const file of closure.values()) {
      if (file.external) continue;
      Object.assign(dependencies, file.info.dependencies);
      Object.assign(devDependencies, file.info.devDependencies);
      pending.push(this.render(file, closure));
    }

    return {
      files: await Promise.all(pending),
      deps: () => createDeps(this.cwd, dependencies, devDependencies),
    };
  }

  async apply(plan: InstallPlan): Promise<void> {
    const written: PlannedFile[] = [];
    for (const file of plan.files) {
      if (file.status === "unchanged") continue;
      if (file.status === "overwrite" && !(await this.io.confirmFileOverride(file))) continue;

      await fs.mkdir(path.dirname(file.output), { recursive: true });
      await fs.writeFile(file.output, file.content);
      written.push(file);
      this.io.onFileWritten(file);
    }

    for (const plugin of this.plugins) await plugin.writeBundle?.call(this.context, written);
  }

  async install(name: string, registry?: string): Promise<InstallPlan> {
    const plan = await this.plan([{ name, registry }]);
    await this.apply(plan);
    return plan;
  }

  private link(id: string): Promise<LinkedFile> {
    const decoded = decodeFileId(id);
    const registry = this.config.registryAliases?.[decoded.registry] ?? decoded.registry;
    id = encodeFileId(registry, decoded.path);

    let linked = this.linked.get(id);
    if (!linked) {
      linked = this.resolveId(id, registry, decoded.path);
      this.linked.set(id, linked);
    }
    return linked;
  }

  private async resolveId(id: string, registry: string, file: string): Promise<LinkedFile> {
    const manifest = await this.fetchManifest(registry);
    const info = manifest.files[file];
    if (!info) throw new Error(`cannot find file ${id}`);

    const base = { id, registry, path: file, info };
    for (const plugin of this.plugins) {
      const resolved = await plugin.resolveId?.call(this.context, base);
      if (resolved) {
        return {
          ...base,
          output: path.resolve(this.cwd, resolved.id),
          external: resolved.external ?? false,
        };
      }
    }

    if (info.type === "route-handler") throw new Error(`no plugin resolved ${id}`);
    const dir = this.destinations[info.type];
    return {
      ...base,
      output: path.resolve(
        this.context.baseDir,
        info.target?.replace("<dir>", dir) ?? path.join(dir, path.basename(file)),
      ),
      external: false,
    };
  }

  private async render(file: LinkedFile, closure: Map<string, LinkedFile>): Promise<PlannedFile> {
    const { info, output } = file;
    const root = await this.fetchManifest();
    const bytes = await this.connector.fetchFile(
      file.path,
      file.registry === root.name ? undefined : file.registry,
    );
    const existing = await fs.readFile(output).catch(() => undefined);

    if (!JS_LANGS.some((lang) => output.endsWith(`.${lang}`))) {
      return { ...file, content: bytes, status: getStatus(existing?.equals(bytes)) };
    }

    const source = new TextDecoder().decode(bytes);
    let code = "";
    let last = 0;
    for (const item of info.imports ?? []) {
      const target = await this.link(item.id);
      const usePackage = item.package && !closure.has(target.id) && !existsSync(target.output);

      code += source.slice(last, item.start);
      code += usePackage ? item.package : toImportSpecifier(output, target.output);
      last = item.end;
    }
    code += source.slice(last);

    for (const plugin of this.plugins) {
      code = (await plugin.transform?.call(this.context, code, file)) ?? code;
    }

    return {
      ...file,
      content: code,
      status: getStatus(existing && existing.toString().trim() === code.trim()),
    };
  }
}

/** `undefined` when the file doesn't exist */
function getStatus(unchanged: boolean | undefined): PlannedFile["status"] {
  if (unchanged === undefined) return "create";
  return unchanged ? "unchanged" : "overwrite";
}

/**
 * Return the import specifier for `sourceFile` to import `referenceFile`
 */
function toImportSpecifier(sourceFile: string, referenceFile: string): string {
  const extname = path.extname(referenceFile);
  const removeExt = JS_LANGS.some((lang) => `.${lang}` === extname);

  let importPath = path
    .relative(
      path.dirname(sourceFile),
      removeExt ? referenceFile.slice(0, -extname.length) : referenceFile,
    )
    .replaceAll(path.sep, "/");

  if (removeExt && importPath.endsWith("/index")) {
    importPath = importPath.slice(0, -"/index".length);
  }

  return importPath.startsWith("../") ? importPath : `./${importPath}`;
}

export type { DependencyManager };
