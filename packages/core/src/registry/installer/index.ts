import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { type Framework, JS_LANGS } from "@/constants";
import { decodeFileId, encodeFileId } from "@/registry/id";
import type { Manifest, ManifestFile, ManifestImport, StmtInfo } from "@/registry/schema";
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
  /** `merge` adds missing declarations to an existing file without touching the rest */
  status: "create" | "overwrite" | "merge" | "unchanged";
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
    const stack: Pick<ManifestImport, "id" | "bindings">[] = [];

    for (const target of targets) {
      const manifest = await this.fetchManifest(target.registry);
      const component = manifest.components.find((item) => item.name === target.name);
      if (!component) throw new Error(`component "${target.name}" not found`);
      for (const file of component.files) stack.push({ id: encodeFileId(manifest.name, file) });
    }

    // files reachable without going through a package import
    const closure = new Map<string, ClosureFile>();
    let request: Pick<ManifestImport, "id" | "bindings"> | undefined;
    while ((request = stack.pop())) {
      const file = await this.link(request.id);
      const { stmtInfos, imports = [] } = file.info;
      let entry = closure.get(file.id);
      if (!entry) {
        entry = { file, bindings: new Set(), imports };
        closure.set(file.id, entry);

        const code =
          stmtInfos && !file.external
            ? await fs.readFile(file.output, "utf-8").catch(() => undefined)
            : undefined;
        if (code !== undefined) {
          const { scanDeclared } = await import("@/compiler/stmt");
          entry.merge = { code, ...scanDeclared(file.output, code) };
        }
      }

      const { bindings } = entry;
      if (bindings === "*") continue;
      if (request.bindings && stmtInfos) {
        const size = bindings.size;
        for (const name of request.bindings) bindings.add(name);
        if (bindings.size === size) continue;
      } else entry.bindings = "*";

      if (file.external) continue;
      if (stmtInfos) {
        // selecting more statements can request more files and bindings
        entry.stmts = selectStmts(stmtInfos, entry.bindings, entry.merge?.names);
        entry.imports = [];
        let i = 0;
        for (const stmt of entry.stmts) {
          while (i < imports.length && imports[i].start < stmt.start) i++;
          for (; i < imports.length && imports[i].start < stmt.end; i++) {
            entry.imports.push(imports[i]);
          }
        }
      }

      for (const item of entry.imports) {
        if (item.package) {
          // a tree-shaken file of the consumer may lack the bindings
          const target = await this.link(item.id);
          if (!target.info.stmtInfos || !existsSync(target.output)) continue;
        }
        stack.push(item);
      }
    }

    const dependencies: Record<string, string | null> = {};
    const devDependencies: Record<string, string | null> = {};
    const pending: Promise<PlannedFile>[] = [];
    for (const entry of closure.values()) {
      if (entry.file.external) continue;
      for (const item of entry.stmts ?? [entry.file.info]) {
        Object.assign(dependencies, item.dependencies);
        Object.assign(devDependencies, item.devDependencies);
      }
      pending.push(this.render(entry, closure));
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

  private async render(
    entry: ClosureFile,
    closure: Map<string, ClosureFile>,
  ): Promise<PlannedFile> {
    const { file, imports, merge } = entry;
    const { output } = file;
    if (merge && entry.stmts!.length === 0) {
      return { ...file, content: merge.code, status: "unchanged" };
    }

    const root = await this.fetchManifest();
    const bytes = await this.connector.fetchFile(
      file.path,
      file.registry === root.name ? undefined : file.registry,
    );
    const existing = merge ? undefined : await fs.readFile(output).catch(() => undefined);

    if (!JS_LANGS.some((lang) => output.endsWith(`.${lang}`))) {
      return { ...file, content: bytes, status: getStatus(existing?.equals(bytes)) };
    }

    const source = new TextDecoder().decode(bytes);
    let head = "";
    let code = "";
    let i = 0;
    const stmts: SelectedStmt[] = entry.stmts ?? [{ start: 0, end: source.length }];
    for (const stmt of stmts) {
      let text = "";
      let last = stmt.start;
      for (; i < imports.length && imports[i].start < stmt.end; i++) {
        const item = imports[i];
        const target = await this.link(item.id);
        const usePackage = item.package && !closure.has(target.id) && !existsSync(target.output);

        text += source.slice(last, item.start);
        text += usePackage ? item.package : toImportSpecifier(output, target.output);
        last = item.start + (item.package ?? item.id).length;
      }
      text += source.slice(last, stmt.end);

      if (merge && stmt.import) head += text;
      else code += text;
    }

    if (merge) {
      const { importEnd } = merge;
      if (head) head = importEnd > 0 ? `\n${head.trim()}` : `${head.trim()}\n\n`;
      head = merge.code.slice(0, importEnd) + head + merge.code.slice(importEnd);
      code = code ? `${head.trimEnd()}\n\n${code.trim()}\n` : head;
    } else if (entry.stmts) {
      code = `${code.trim()}\n`;
    }

    for (const plugin of this.plugins) {
      code = (await plugin.transform?.call(this.context, code, file)) ?? code;
    }

    return {
      ...file,
      content: code,
      status: merge ? "merge" : getStatus(existing && existing.toString().trim() === code.trim()),
    };
  }
}

type SelectedStmt = StmtInfo & { start: number };

interface ClosureFile {
  file: LinkedFile;
  /** names requested from the file, `*` for the whole file */
  bindings: Set<string> | "*";
  /** statements to install, `undefined` for the whole file */
  stmts?: SelectedStmt[];
  /** imports inside `stmts` */
  imports: ManifestImport[];
  /** the file of consumer to add `stmts` to */
  merge?: { code: string; names: Set<string>; importEnd: number };
}

/**
 * @param declared - names the consumer's file already has, given when merging
 * @returns statements needed for `bindings` in source order, the ones `declared` are left out.
 */
function selectStmts(
  stmts: StmtInfo[],
  bindings: Set<string> | "*",
  declared?: Set<string>,
): SelectedStmt[] {
  const selected: boolean[] = [];
  const stack: number[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const { declares } = stmts[i];
    // statements without names are part of every new file
    if (declares ? bindings === "*" || declares.some((v) => bindings.has(v)) : !declared)
      stack.push(i);
  }

  let i: number | undefined;
  while ((i = stack.pop()) !== undefined) {
    const { declares, references = [] } = stmts[i];
    if (selected[i] || (declared && declares?.some((v) => declared.has(v)))) continue;
    selected[i] = true;
    for (const ref of references) stack.push(ref);
  }

  const out: SelectedStmt[] = [];
  for (let i = 0; i < stmts.length; i++) {
    if (selected[i]) out.push({ ...stmts[i], start: i === 0 ? 0 : stmts[i - 1].end });
  }
  return out;
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
