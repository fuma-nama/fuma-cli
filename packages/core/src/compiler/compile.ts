import path from "node:path";
import fs from "node:fs";
import { findPackageJSON, isBuiltin } from "node:module";
import { pathToFileURL } from "node:url";
import MagicString from "magic-string";
import { ResolverFactory } from "oxc-resolver";
import { MACRO_PATH, SCRIPT_EXTS } from "@/constants";
import { encodeFileId } from "@/registry/id";
import type { Manifest, ManifestComponent, ManifestFile } from "@/registry/schema";
import type { PackageJson } from "@/types";
import { findNearestPackageJson, toPosix } from "@/utils/fs";
import { buildExportIndex, type ExportIndex, type PackageImport, toPackageImport } from "./exports";
import type { FileRule, Registry } from "./registry";
import { type CompiledRule, compileRule, getRestStart, glob, matchRule } from "./rules";
import { type ImportRecord, isScannable, scan, type ScanResult } from "./scan";
import { stmtAt } from "./stmt";

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
  rules: CompiledRule[];
  /** `<type>:<file name>` of files without `target` -> file */
  flattened: Map<string, string>;
  exportIndex?: ExportIndex;
  output: CompiledRegistry;
}

/** a file of registry, everything known about it is resolved once */
interface SourceFile {
  file: string;
  registry: RegistryState;
  /** relative to registry dir */
  path: string;
  rule?: FileRule;
  /** `null` if it is not a script */
  scanned?: ScanResult | null;
  module?: Module;
}

/** an installable file */
interface Module {
  /** `<registry>:<path>` */
  id: string;
  source: SourceFile;
  preserve: boolean;
  treeshake: boolean;
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

/** a file of registry, or the name of a package */
type ResolvedId = { source: SourceFile; specifier?: string } | string;

const OUT_DIR = "./dist/";

export async function compile({ root }: CompileOptions): Promise<CompiledRegistry> {
  const registries: RegistryState[] = [];
  /** package name -> registry */
  const packages = new Map<string, RegistryState>();
  const sources = new Map<string, SourceFile>();
  /** in the order to process */
  const modules: Module[] = [];
  const errors: string[] = [];
  const resolver = new ResolverFactory({
    extensions: [...SCRIPT_EXTS, ".node"],
    extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".jsx": [".tsx", ".jsx"] },
    conditionNames: ["node", "import", "require", "default", "types"],
    tsconfig: "auto",
  });

  // --- files

  /** @param registry - the registry of file if known, otherwise the deepest one containing it */
  function getSource(file: string, registry?: RegistryState): SourceFile | undefined {
    let source = sources.get(file);
    if (source) return source;

    if (!registry) {
      for (const item of registries) {
        if (!file.startsWith(item.dir + path.sep)) continue;
        if (!registry || item.dir.length > registry.dir.length) registry = item;
      }
      if (!registry) return;
    }

    const relative = toPosix(path.relative(registry.dir, file));
    source = {
      file,
      registry,
      path: relative,
      // files outside of `dir` cannot be served
      rule: relative.startsWith("../") ? undefined : matchRule(registry.rules, relative),
    };
    sources.set(file, source);
    return source;
  }

  function scanSource(source: SourceFile): ScanResult | undefined {
    if (source.scanned === undefined) {
      const { file, rule } = source;
      source.scanned = isScannable(path.extname(file))
        ? scan(file, fs.readFileSync(file, "utf-8"), rule && !("alias" in rule) && rule.treeshake)
        : null;
    }
    return source.scanned ?? undefined;
  }

  /** @returns `undefined` if the file is not installable */
  function getModule(source: SourceFile): Module | undefined {
    const { rule, registry, file } = source;
    if (source.module || !rule || "alias" in rule) return source.module;

    const { preserve = false, treeshake = false, ...output } = rule;
    if (treeshake && !isScannable(path.extname(file))) {
      errors.push(`${file}: only scripts can be tree-shaken`);
    }

    if (output.type !== "route-handler" && !output.target) {
      const key = `${output.type}:${path.basename(file)}`;
      const other = registry.flattened.get(key);
      if (other) {
        errors.push(
          `${file}: installed to the same location as ${other}, set \`target\` in its rule`,
        );
      } else registry.flattened.set(key, file);
    }

    source.module = {
      id: encodeFileId(registry.registry.name, source.path),
      source,
      preserve,
      treeshake,
      edits: [],
      output,
    };
    modules.push(source.module);
    registry.output.manifest.files[source.path] = output;
    return source.module;
  }

  // --- scan stage

  function scanRegistry(registry: Registry): CompiledRegistry {
    const dir = path.resolve(registry.dir);
    const pkg = findNearestPackageJson(dir);
    if (!pkg) throw new Error(`failed to find the package.json of registry "${registry.name}"`);

    const state: RegistryState = {
      registry,
      dir,
      packageJson: JSON.parse(fs.readFileSync(pkg, "utf-8")),
      entries: new Map(),
      rules: [],
      flattened: new Map(),
      output: {
        manifest: { name: registry.name, components: [], files: {} },
        files: new Map(),
        subRegistries: [],
      },
    };
    registries.push(state);

    const { name } = state.packageJson;
    if (name && !packages.has(name)) packages.set(name, state);

    resolveEntries(state);
    for (const pattern in registry.files) {
      const rule = compileRule(pattern, registry.files[pattern]);
      if (rule.rest === undefined && !fs.existsSync(path.join(dir, pattern))) {
        errors.push(`registry "${registry.name}": cannot find "${pattern}" of \`files\``);
      }
      state.rules.push(rule);
    }

    for (const key in registry.components) scanComponent(state, key);

    if (registry.subRegistries) {
      state.output.manifest.registries = [];
      for (const child of registry.subRegistries) {
        state.output.manifest.registries.push(child.name);
        state.output.subRegistries.push(scanRegistry(child));
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

  function scanComponent(state: RegistryState, key: string) {
    const { dir, registry } = state;
    const { components } = state.output.manifest;
    const value = registry.components![key];
    const { entry, ...info } =
      typeof value === "object" && !Array.isArray(value) ? value : { entry: value };
    // `*` in name: a component per entry
    const shared: ManifestComponent | false = !key.includes("*") && {
      name: key,
      ...info,
      files: [],
    };
    if (shared) components.push(shared);

    for (const item of typeof entry === "string" ? [entry] : entry) {
      const start = getRestStart(item);
      let matched: string[] = [];
      if (start !== undefined) matched = glob(dir, item, start);
      else if (fs.existsSync(path.join(dir, item))) matched = [toPosix(path.normalize(item))];

      if (matched.length === 0) {
        errors.push(`registry "${registry.name}": cannot find "${item}" of component "${key}"`);
      }

      for (const file of matched) {
        if (!getModule(getSource(path.join(dir, file), state)!)) {
          errors.push(
            `registry "${registry.name}": "${file}" of component "${key}" matches no rule in \`files\``,
          );
        } else if (shared) {
          shared.files.push(file);
        } else {
          components.push({
            name: key.replace("*", file.slice(start, -path.extname(file).length)),
            ...info,
            files: [file],
          });
        }
      }
    }
  }

  // --- link stage

  /** @param registry - of importer */
  function resolveId(
    specifier: string,
    importer: string,
    registry: RegistryState,
  ): ResolvedId | undefined {
    const isBare = !specifier.startsWith(".") && !path.isAbsolute(specifier);

    if (isBare) {
      const name = getPackageName(specifier);
      const target = packages.get(name);
      if (target) {
        const entry = target.entries.get(specifier);
        const source = entry && getSource(entry);
        return source ? resolveAlias(source, specifier) : name;
      }

      // most of the resolution time is spent in `node_modules`
      if (getDeclaredVersion(registry.packageJson, name)) return name;
    }

    const { path: file } = resolver.resolveFileSync(importer, specifier);
    const source =
      file && !file.includes(`${path.sep}node_modules${path.sep}`) ? getSource(file) : undefined;
    if (source) return resolveAlias(source);
    if (isBare) return getPackageName(specifier);
  }

  function resolveAlias(source: SourceFile, specifier?: string): ResolvedId | undefined {
    const { rule, registry } = source;
    if (!rule || !("alias" in rule)) return { source, specifier };

    const out = resolveId(rule.alias, path.join(registry.dir, "index.ts"), registry);
    if (!out || typeof out === "string") {
      errors.push(`${source.file}: cannot resolve alias "${rule.alias}"`);
    }
    return out;
  }

  function getPackageImport(
    record: ImportRecord,
    { source, specifier }: Exclude<ResolvedId, string>,
    quote: string,
  ): PackageImport {
    const { registry } = source;
    if (registry.packageJson.private) return { missing: record.bindings ?? ["*"] };
    if (specifier) return { specifier };

    registry.exportIndex ??= buildExportIndex(
      registry.entries,
      (file) => {
        const entry = getSource(file);
        return entry && scanSource(entry);
      },
      (specifier, importer) => {
        const resolved = resolveId(specifier, importer, registry);
        if (typeof resolved === "object") return resolved.source.file;
      },
    );
    return toPackageImport(registry.exportIndex, source.file, record, quote);
  }

  /** @param pos - position of the import, tree-shaken modules carry dependencies on statements */
  function addDependency(module: Module, name: string, pos: number) {
    const { registry, packageJson, dir } = module.source.registry;
    let version: string | null | undefined;

    if (registry.dependencies && name in registry.dependencies) {
      version = registry.dependencies[name];
    } else {
      version = getDeclaredVersion(packageJson, name);

      const pkg = packages.get(name)?.packageJson;
      if (pkg) version = `^${pkg.version}`;
      // protocols of package manager like `workspace:`
      else if (version?.includes(":")) {
        try {
          const file = findPackageJSON(name, pathToFileURL(dir + path.sep))!;
          version = `^${JSON.parse(fs.readFileSync(file, "utf-8")).version}`;
        } catch {
          version = null;
        }
      }
    }

    const types = `@types/${name}`;
    if (version === undefined && packageJson.devDependencies?.[types]) {
      name = types;
      version = packageJson.devDependencies[types];
    } else if (version === undefined) {
      errors.push(
        `${module.source.file}: "${name}" is not a dependency of its package. Add it to package.json or \`dependencies\` of registry, a path alias means the file is excluded by its tsconfig.json.`,
      );
      return;
    }

    const stmts = scanSource(module.source)?.stmts;
    const output = stmts ? stmts[stmtAt(stmts, pos)] : module.output;
    if (name.startsWith("@types/")) (output.devDependencies ??= {})[name] = version;
    else (output.dependencies ??= {})[name] = version;
  }

  function isExternal({ registry, path: file }: SourceFile) {
    const { external } = registry.registry;
    if (!external) return false;
    for (const item of external) {
      if (file === item || file.startsWith(`${item}/`)) return true;
    }
    return false;
  }

  function linkImport(module: Module, record: ImportRecord, quote: string) {
    const { specifier, start, end, bindings } = record;
    if (isBuiltin(specifier) || specifier.startsWith(MACRO_PATH)) return;
    const { file, registry } = module.source;

    const resolved = resolveId(specifier, file, registry);
    if (!resolved) {
      // an URL may point to anything
      if (record.kind !== "new-url") errors.push(`${file}: cannot resolve "${specifier}"`);
      return;
    }

    if (typeof resolved === "string") {
      if (record.kind !== "new-url") addDependency(module, resolved, start);
      return;
    }

    const { source } = resolved;
    if (isExternal(source)) return;
    const target = getModule(source);
    const swap = !target || target.preserve ? getPackageImport(record, resolved, quote) : {};

    // preserved modules without a public equivalent are linked as usual
    if (swap.specifier === undefined && (target || swap.declaration === undefined)) {
      if (target) {
        module.edits.push({
          start,
          end,
          text: target.id,
          link: { id: target.id, bindings: target.treeshake ? bindings : undefined },
        });
        return;
      }

      errors.push(
        `${file}: "${specifier}" matches no rule in \`files\` of registry "${source.registry.registry.name}", and ${swap.missing!.join(", ")} of it is not a public export of "${source.registry.packageJson.name}". Add a rule for ${source.path}, or export it from the package.`,
      );
      return;
    }

    addDependency(module, source.registry.packageJson.name!, start);
    if (swap.specifier !== undefined) {
      module.edits.push({
        start,
        end,
        text: swap.specifier,
        link: target && {
          id: target.id,
          bindings: target.treeshake ? bindings : undefined,
          package: swap.specifier,
        },
      });
    } else {
      const { start, end } = record.declaration!;
      module.edits.push({ start, end, text: swap.declaration! });
    }
  }

  const output = scanRegistry(root);

  // modules are appended on the way
  for (const module of modules) {
    const scanned = scanSource(module.source);
    if (!scanned) continue;
    for (const record of scanned.imports) {
      linkImport(module, record, scanned.code[record.start - 1]);
    }
  }

  if (errors.length > 0) throw new Error(errors.join("\n\n"));

  // --- generate stage

  for (const { source, edits, output } of modules) {
    const { files } = source.registry.output;
    const scanned = scanSource(source);
    if (!scanned) {
      files.set(source.path, fs.readFileSync(source.file));
      continue;
    }

    const { code, stmts } = scanned;
    const s = new MagicString(code);
    edits.sort((a, b) => a.start - b.start);
    let delta = 0;
    let i = 0;

    // edits are inside statements, links & statements are positioned in the output
    for (const stmt of stmts ?? [{ end: code.length }]) {
      for (; i < edits.length && edits[i].start < stmt.end; i++) {
        const { start, end, text, link } = edits[i];
        if (link) (output.imports ??= []).push({ ...link, start: start + delta });
        s.update(start, end, text);
        delta += text.length - (end - start);
      }
      stmt.end += delta;
    }

    if (stmts) output.stmtInfos = stmts;
    files.set(source.path, s.toString());
  }
  return output;
}

function getDeclaredVersion(pkg: PackageJson, name: string): string | undefined {
  return pkg.dependencies?.[name] ?? pkg.peerDependencies?.[name] ?? pkg.devDependencies?.[name];
}

function findSource(base: string) {
  for (const ext of SCRIPT_EXTS) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
}

function getPackageName(specifier: string) {
  const parts = specifier.split("/", 2);
  return specifier.startsWith("@") ? parts.join("/") : parts[0];
}
