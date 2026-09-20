import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { ResolverFactory } from "oxc-resolver";
import { MACRO_PATH } from "@/constants";
import { encodeFileId, type Manifest, type ManifestFile } from "@/registry/schema";
import type { PackageJson } from "@/types";
import { findNearestPackageJson } from "@/utils/fs";
import { buildExportIndex, type ExportIndex, nameKey } from "./exports";
import type { InstallInfo, Registry } from "./registry";
import { type ImportRecord, isScannable, scan, type ScanResult } from "./scan";

export interface CompileOptions {
  root: Registry;
}

export interface CompiledRegistry {
  manifest: Manifest;
  /** file path -> content */
  files: Map<string, string | Buffer>;
  subRegistries: CompiledRegistry[];
}

interface RegistryState {
  registry: Registry;
  dir: string;
  packageJson: PackageJson;
  /** specifier -> source file */
  entries: Map<string, string>;
  exportIndex?: ExportIndex;
  components: Map<string, Manifest["components"][number]>;
  output: CompiledRegistry;
}

/** an installable file */
interface Module {
  /** `<registry>:<path>` */
  id: string;
  registry: RegistryState;
  file: string;
  /** relative to registry dir */
  path: string;
  preserve: boolean;
  edits: Edit[];
  output: ManifestFile;
}

interface Edit {
  start: number;
  end: number;
  text: string;
  /** the edit is an import for installer to link */
  link?: { id: string; bindings?: string[]; package?: string };
}

type ResolvedId =
  | { id: string; external: false; registry: RegistryState; specifier?: string }
  /** `id` is the package name */
  | { id: string; external: true };

/** an import of `specifier`, a rewritten `declaration`, or the bindings `missing` from the package */
interface PackageImport {
  specifier?: string;
  declaration?: string;
  missing?: string[];
}

const SIDECAR = /\.install\.ts$/;
const OUT_DIR = "./dist/";
const SOURCE_EXTS = [".tsx", ".ts", ".jsx", ".js"];

export async function compile({ root }: CompileOptions): Promise<CompiledRegistry> {
  const registries: RegistryState[] = [];
  /** package name -> registry */
  const packages = new Map<string, RegistryState>();
  /** file -> module, in the order to process */
  const modules = new Map<string, Module>();
  /** file -> the specifier of file installed in place of it, and where to resolve it from */
  const aliases = new Map<string, { specifier: string; importer: string }>();
  const scanned = new Map<string, (ScanResult & { code: string }) | undefined>();
  const errors: string[] = [];
  const resolver = new ResolverFactory({
    extensions: [...SOURCE_EXTS, ".node"],
    conditionNames: ["node", "import", "require", "default", "types"],
    tsconfig: "auto",
  });

  // --- scan stage

  function scanFile(file: string) {
    if (scanned.has(file)) return scanned.get(file);
    const ext = path.extname(file);
    let out: (ScanResult & { code: string }) | undefined;
    if (isScannable(ext)) {
      const code = fs.readFileSync(file, "utf-8");
      out = Object.assign(scan(file, ext, code), { code });
    }
    scanned.set(file, out);
    return out;
  }

  function addModule(registry: RegistryState, file: string, info: InstallInfo, importer: string) {
    if ("alias" in info) {
      aliases.set(file, { specifier: info.alias, importer });
      return;
    }

    const { component, preserve = false, ...output } = info;
    const relative = toPosix(path.relative(registry.dir, file));
    const module: Module = {
      id: encodeFileId(registry.registry.name, relative),
      registry,
      file,
      path: relative,
      preserve,
      edits: [],
      output,
    };
    modules.set(file, module);
    registry.output.manifest.files[relative] = output;

    if (!component) return module;
    const name = typeof component === "string" ? component : component.name;
    let entry = registry.components.get(name);
    if (!entry) {
      entry = { name, files: [] };
      registry.components.set(name, entry);
    }
    if (typeof component === "object") Object.assign(entry, component);
    entry.files.push(relative);
    return module;
  }

  async function scanRegistry(registry: Registry): Promise<CompiledRegistry> {
    const dir = path.resolve(registry.dir);
    const pkg = findNearestPackageJson(dir);
    if (!pkg) throw new Error(`failed to find the package.json of registry "${registry.name}"`);

    const state: RegistryState = {
      registry,
      dir,
      packageJson: JSON.parse(fs.readFileSync(pkg, "utf-8")),
      entries: new Map(),
      components: new Map(),
      output: {
        manifest: { name: registry.name, components: [], files: {} },
        files: new Map(),
        subRegistries: [],
      },
    };
    registries.push(state);
    resolveEntries(state);

    const { name } = state.packageJson;
    if (name && !packages.has(name)) packages.set(name, state);

    const sidecars = findSidecars(dir);
    const loaded = await Promise.all(sidecars.map((file) => import(pathToFileURL(file).href)));
    for (let i = 0; i < sidecars.length; i++) {
      const base = sidecars[i].replace(SIDECAR, "");
      const file = fs.existsSync(base) ? base : findSource(base);
      if (file) addModule(state, file, loaded[i].default, sidecars[i]);
      else errors.push(`${sidecars[i]}: cannot find the file it describes`);
    }

    if (registry.files) {
      for (const k in registry.files) {
        const file = path.join(dir, k);
        addModule(state, file, registry.files[k], file);
      }
    }

    if (registry.subRegistries) {
      state.output.manifest.registries = [];
      for (const child of registry.subRegistries) {
        state.output.manifest.registries.push(child.name);
        state.output.subRegistries.push(await scanRegistry(child));
      }
    }

    return state.output;
  }

  function resolveEntries(state: RegistryState) {
    const { registry, packageJson, dir } = state;
    const toSpecifier = (subpath: string) => path.posix.join(packageJson.name ?? "", subpath);

    if (registry.entries) {
      for (const k in registry.entries) {
        state.entries.set(toSpecifier(k), path.join(dir, registry.entries[k]));
      }
      return;
    }

    for (const k in packageJson.exports) {
      const value = packageJson.exports[k];
      const target = typeof value === "object" ? (value.import ?? value.default) : value;
      if (!target || !target.startsWith(OUT_DIR) || target.includes("*")) continue;

      const base = path.join(dir, target.slice(OUT_DIR.length, -path.extname(target).length));
      const file = findSource(base);
      if (file) state.entries.set(toSpecifier(k), file);
    }
  }

  // --- link stage

  function resolveId(specifier: string, importer: string): ResolvedId | undefined {
    const isBare = !specifier.startsWith(".") && !path.isAbsolute(specifier);

    if (isBare) {
      const name = getPackageName(specifier);
      const registry = packages.get(name);
      if (registry) {
        const id = registry.entries.get(specifier);
        if (!id) return { id: name, external: true };
        return resolveAlias({ id, external: false, registry, specifier });
      }
    }

    const { path: id } = resolver.resolveFileSync(importer, specifier);
    if (id && !id.includes(`${path.sep}node_modules${path.sep}`)) {
      let owner: RegistryState | undefined;
      for (const registry of registries) {
        if (!id.startsWith(registry.dir + path.sep)) continue;
        if (!owner || registry.dir.length > owner.dir.length) owner = registry;
      }
      if (owner) return resolveAlias({ id, external: false, registry: owner });
    }

    if (isBare) return { id: getPackageName(specifier), external: true };
  }

  function resolveAlias(resolved: ResolvedId): ResolvedId | undefined {
    const alias = !resolved.external && aliases.get(resolved.id);
    if (!alias) return resolved;

    const out = resolveId(alias.specifier, alias.importer);
    if (!out || out.external) errors.push(`${alias.importer}: cannot resolve "${alias.specifier}"`);
    return out;
  }

  function getExportIndex(registry: RegistryState): ExportIndex {
    return (registry.exportIndex ??= buildExportIndex(
      registry.entries,
      scanFile,
      (specifier, importer) => {
        const resolved = resolveId(specifier, importer);
        if (resolved && !resolved.external) return resolved.id;
      },
    ));
  }

  /**
   * @returns the package import of `record`, or bindings that the package doesn't export.
   */
  function toPackageImport(
    record: ImportRecord,
    target: Extract<ResolvedId, { external: false }>,
    quote: string,
  ): PackageImport {
    if (target.registry.packageJson.private) return { missing: record.bindings ?? ["*"] };
    if (target.specifier) return { specifier: target.specifier };
    const index = getExportIndex(target.registry);
    const entry = index.modules.get(target.id);
    if (entry) return { specifier: entry };
    if (!record.bindings) return { missing: ["*"] };

    const missing: string[] = [];
    let specifier: string | undefined;
    let renamed = false;
    for (const name of record.bindings) {
      const found = index.names.get(nameKey(target.id, name));
      if (!found) {
        missing.push(name);
        continue;
      }

      renamed ||= found.name !== name || (specifier !== undefined && specifier !== found.specifier);
      specifier = found.specifier;
    }

    if (missing.length > 0) return { missing };
    if (!renamed) return { specifier: specifier! };
    if (!record.declaration) return { missing: record.bindings };

    // specifier -> import clause
    const clauses = new Map<string, { default?: string; named: string[] }>();
    for (const binding of record.declaration.bindings) {
      const found = index.names.get(nameKey(target.id, binding.imported))!;
      let clause = clauses.get(found.specifier);
      if (!clause) {
        clause = { named: [] };
        clauses.set(found.specifier, clause);
      }

      if (found.name === "default" && !binding.isType) clause.default = binding.local;
      else {
        const text =
          found.name === binding.local ? binding.local : `${found.name} as ${binding.local}`;
        clause.named.push(binding.isType ? `type ${text}` : text);
      }
    }

    const lines: string[] = [];
    for (const [k, clause] of clauses) {
      const parts: string[] = [];
      if (clause.default) parts.push(clause.default);
      if (clause.named.length > 0) parts.push(`{ ${clause.named.join(", ")} }`);
      lines.push(`import ${parts.join(", ")} from ${quote}${k}${quote};`);
    }
    return { declaration: lines.join("\n") };
  }

  function inherit(importer: Module, file: string): Module | undefined {
    const { output, registry } = importer;
    const dir = path.dirname(importer.file);
    if (output.type === "route-handler" || !file.startsWith(dir + path.sep)) return;

    const base = output.target ? path.posix.dirname(output.target) : "<dir>";
    return addModule(
      registry,
      file,
      { type: output.type, target: path.posix.join(base, toPosix(path.relative(dir, file))) },
      importer.file,
    );
  }

  function addDependency(module: Module, name: string) {
    const { registry, packageJson, dir } = module.registry;
    let version: string | null | undefined;

    if (registry.dependencies && name in registry.dependencies) {
      version = registry.dependencies[name];
    } else {
      version =
        packageJson.dependencies?.[name] ??
        packageJson.peerDependencies?.[name] ??
        packageJson.devDependencies?.[name];

      const pkg = packages.get(name)?.packageJson;
      if (pkg) version = `^${pkg.version}`;
      // protocols of package manager like `workspace:`
      else if (version?.includes(":")) {
        const { path: file } = resolver.sync(dir, `${name}/package.json`);
        version = file ? `^${JSON.parse(fs.readFileSync(file, "utf-8")).version}` : null;
      }
    }

    const types = `@types/${name}`;
    if (version === undefined && packageJson.devDependencies?.[types]) {
      name = types;
      version = packageJson.devDependencies[types];
    } else if (version === undefined) {
      console.warn(`${module.file}: "${name}" is not a dependency of its package`);
      version = null;
    }

    const { output } = module;
    if (name.startsWith("@types/")) (output.devDependencies ??= {})[name] = version;
    else (output.dependencies ??= {})[name] = version;
  }

  function isExternal({ registry, id }: Extract<ResolvedId, { external: false }>) {
    const { external } = registry.registry;
    if (!external) return false;
    const relative = toPosix(path.relative(registry.dir, id));
    return external.some((v) => relative === v || relative.startsWith(v + "/"));
  }

  function linkImport(module: Module, record: ImportRecord, quote: string) {
    const { specifier, start, end, bindings } = record;
    if (specifier.startsWith("node:") || specifier.startsWith(MACRO_PATH)) return;

    const resolved = resolveId(specifier, module.file);
    if (!resolved) {
      // an URL may point to anything
      if (record.kind !== "new-url") errors.push(`${module.file}: cannot resolve "${specifier}"`);
      return;
    }

    if (resolved.external) {
      if (record.kind !== "new-url") addDependency(module, resolved.id);
      return;
    }

    if (isExternal(resolved)) return;
    const target = modules.get(resolved.id);
    const swap = !target || target.preserve ? toPackageImport(record, resolved, quote) : {};

    // preserved modules without a public equivalent are linked as usual
    if (swap.specifier === undefined && (target || swap.declaration === undefined)) {
      const local = target ?? inherit(module, resolved.id);
      if (local) {
        module.edits.push({ start, end, text: local.id, link: { id: local.id, bindings } });
        return;
      }

      const { dir, packageJson } = resolved.registry;
      const relative = path.relative(dir, resolved.id);
      errors.push(
        `${module.file}: "${specifier}" has no sidecar, and ${swap.missing!.join(", ")} of it is not a public export of "${packageJson.name}". Add ${relative.slice(0, -path.extname(relative).length)}.install.ts, or export it from the package.`,
      );
      return;
    }

    addDependency(module, resolved.registry.packageJson.name!);
    if (swap.specifier !== undefined) {
      module.edits.push({
        start,
        end,
        text: swap.specifier,
        link: target && { id: target.id, bindings, package: swap.specifier },
      });
    } else {
      const { start, end } = record.declaration!;
      module.edits.push({ start, end, text: swap.declaration! });
    }
  }

  // --- generate stage

  function render(module: Module) {
    const { registry, file, edits, output } = module;
    const code = scanFile(file)?.code;
    if (code === undefined) {
      registry.output.files.set(module.path, fs.readFileSync(file));
      return;
    }

    edits.sort((a, b) => a.start - b.start);
    let out = "";
    let last = 0;
    for (const edit of edits) {
      out += code.slice(last, edit.start);
      if (edit.link) {
        (output.imports ??= []).push({
          ...edit.link,
          start: out.length,
          end: out.length + edit.text.length,
        });
      }
      out += edit.text;
      last = edit.end;
    }
    registry.output.files.set(module.path, out + code.slice(last));
  }

  const output = await scanRegistry(root);

  // inherited modules are appended on the way
  for (const module of modules.values()) {
    const result = scanFile(module.file);
    if (!result) continue;
    for (const record of result.imports) linkImport(module, record, result.code[record.start - 1]);
  }

  if (errors.length > 0) throw new Error(errors.join("\n\n"));

  for (const module of modules.values()) render(module);
  for (const registry of registries) {
    registry.output.manifest.components = Array.from(registry.components.values());
  }
  return output;
}

function findSidecars(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) findSidecars(file, out);
    else if (SIDECAR.test(entry.name)) out.push(file);
  }
  return out;
}

function findSource(base: string) {
  for (const ext of SOURCE_EXTS) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
}

function getPackageName(specifier: string) {
  const parts = specifier.split("/", 2);
  return specifier.startsWith("@") ? parts.join("/") : parts[0];
}

function toPosix(file: string) {
  return path.sep === "/" ? file : file.replaceAll(path.sep, "/");
}
