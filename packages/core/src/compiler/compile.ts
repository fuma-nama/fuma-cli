import path from "node:path";
import fs from "node:fs";
import { findPackageJSON, isBuiltin } from "node:module";
import { pathToFileURL } from "node:url";
import { ResolverFactory } from "oxc-resolver";
import { MACRO_PATH } from "@/constants";
import { encodeFileId } from "@/registry/id";
import type { Manifest, ManifestFile } from "@/registry/schema";
import type { PackageJson } from "@/types";
import { findNearestPackageJson } from "@/utils/fs";
import { buildExportIndex, type ExportIndex, nameKey } from "./exports";
import type { FileRule, Registry } from "./registry";
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
  /** `fixed` is the part before globs, `undefined` for a path */
  rules: { pattern: string; fixed?: string; rule: FileRule }[];
  exportIndex?: ExportIndex;
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

const OUT_DIR = "./dist/";
const SOURCE_EXTS = [".tsx", ".ts", ".jsx", ".js"];

export async function compile({ root }: CompileOptions): Promise<CompiledRegistry> {
  const registries: RegistryState[] = [];
  /** package name -> registry */
  const packages = new Map<string, RegistryState>();
  /** file -> module, in the order to process */
  const modules = new Map<string, Module>();
  /** file -> its rule in `files` of registry */
  const rules = new Map<string, FileRule | undefined>();
  const scanned = new Map<string, ScanResult | undefined>();
  const errors: string[] = [];
  const resolver = new ResolverFactory({
    extensions: [...SOURCE_EXTS, ".node"],
    extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".jsx": [".tsx", ".jsx"] },
    conditionNames: ["node", "import", "require", "default", "types"],
    tsconfig: "auto",
  });

  // --- scan stage

  function isTreeshaken(file: string) {
    const rule = getRule(file);
    return rule !== undefined && !("alias" in rule) && rule.treeshake;
  }

  function scanFile(file: string) {
    if (scanned.has(file)) return scanned.get(file);
    const out = isScannable(path.extname(file))
      ? scan(file, fs.readFileSync(file, "utf-8"), isTreeshaken(file))
      : undefined;
    scanned.set(file, out);
    return out;
  }

  function getOwner(file: string) {
    let owner: RegistryState | undefined;
    for (const registry of registries) {
      if (!file.startsWith(registry.dir + path.sep)) continue;
      if (!owner || registry.dir.length > owner.dir.length) owner = registry;
    }
    return owner;
  }

  function getRule(file: string, registry?: RegistryState) {
    if (rules.has(file)) return rules.get(file);
    registry ??= getOwner(file);
    let out: FileRule | undefined;

    const relative = registry && toPosix(path.relative(registry.dir, file));
    // files outside of `dir` cannot be served
    if (relative && !relative.startsWith("../")) {
      for (const { pattern, fixed, rule } of registry!.rules) {
        if (fixed === undefined) {
          if (relative !== pattern) continue;
          // compiling a glob is slow, skip when the fixed part already differs
        } else if (!relative.startsWith(fixed) || !path.posix.matchesGlob(relative, pattern)) {
          continue;
        }

        out = rule;
        if (fixed === undefined) break;
        // `*` refers to the path after the fixed part of pattern
        const rest = relative.slice(fixed.length);
        if ("alias" in rule) out = { alias: rule.alias.replace(/\*+/, rest) };
        else if ("target" in rule && rule.target) {
          out = { ...rule, target: rule.target.replace(/\*+/, rest) };
        }
        break;
      }
    }

    rules.set(file, out);
    return out;
  }

  /** @returns the installable file, `undefined` if no rule matches it */
  function getModule(file: string, registry: RegistryState) {
    let module = modules.get(file);
    if (module) return module;
    const rule = getRule(file, registry);
    if (!rule || "alias" in rule) return;

    const { preserve = false, treeshake = false, ...output } = rule;
    if (treeshake && !isScannable(path.extname(file))) {
      errors.push(`${file}: only scripts can be tree-shaken`);
    }

    const relative = toPosix(path.relative(registry.dir, file));
    module = {
      id: encodeFileId(registry.registry.name, relative),
      registry,
      file,
      path: relative,
      preserve,
      treeshake,
      edits: [],
      output,
    };
    modules.set(file, module);
    registry.output.manifest.files[relative] = output;
    return module;
  }

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
      output: {
        manifest: { name: registry.name, components: [], files: {} },
        files: new Map(),
        subRegistries: [],
      },
    };
    registries.push(state);
    resolveEntries(state);
    for (const pattern in registry.files) {
      const glob = pattern.search(/[^/]*[*?[{]/);
      state.rules.push({
        pattern,
        fixed: glob === -1 ? undefined : pattern.slice(0, glob),
        rule: registry.files[pattern],
      });
    }

    const { name } = state.packageJson;
    if (name && !packages.has(name)) packages.set(name, state);

    for (const name in registry.components) {
      const value = registry.components[name];
      const { entry, ...info } =
        typeof value === "object" && !Array.isArray(value) ? value : { entry: value };
      const component: Manifest["components"][number] = { name, ...info, files: [] };

      for (const item of typeof entry === "string" ? [entry] : entry) {
        const file = path.join(dir, item);
        if (!fs.existsSync(file))
          errors.push(`registry "${registry.name}": cannot find "${item}" of component "${name}"`);
        else if (getModule(file, state)) component.files.push(toPosix(path.normalize(item)));
        else
          errors.push(
            `registry "${registry.name}": "${item}" of component "${name}" matches no rule in \`files\``,
          );
      }
      state.output.manifest.components.push(component);
    }

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
      const owner = getOwner(id);
      if (owner) return resolveAlias({ id, external: false, registry: owner });
    }

    if (isBare) return { id: getPackageName(specifier), external: true };
  }

  function resolveAlias(
    resolved: Extract<ResolvedId, { external: false }>,
  ): ResolvedId | undefined {
    const rule = getRule(resolved.id, resolved.registry);
    if (!rule || !("alias" in rule)) return resolved;

    const importer = path.join(resolved.registry.dir, "index.ts");
    const out = resolveId(rule.alias, importer);
    if (!out || out.external) errors.push(`${resolved.id}: cannot resolve alias "${rule.alias}"`);
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

  /** @param pos - position of the import, tree-shaken modules carry dependencies on statements */
  function addDependency(module: Module, name: string, pos: number) {
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
        `${module.file}: "${name}" is not a dependency of its package. Add it to package.json or \`dependencies\` of registry, a path alias means the file is excluded by its tsconfig.json.`,
      );
      return;
    }

    const stmts = scanFile(module.file)?.stmts;
    const output = stmts ? stmts[stmtAt(stmts, pos)] : module.output;
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
    if (isBuiltin(specifier) || specifier.startsWith(MACRO_PATH)) return;

    const resolved = resolveId(specifier, module.file);
    if (!resolved) {
      // an URL may point to anything
      if (record.kind !== "new-url") errors.push(`${module.file}: cannot resolve "${specifier}"`);
      return;
    }

    if (resolved.external) {
      if (record.kind !== "new-url") addDependency(module, resolved.id, start);
      return;
    }

    if (isExternal(resolved)) return;
    const target = getModule(resolved.id, resolved.registry);
    const swap = !target || target.preserve ? toPackageImport(record, resolved, quote) : {};

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

      const { dir, packageJson, registry } = resolved.registry;
      errors.push(
        `${module.file}: "${specifier}" matches no rule in \`files\` of registry "${registry.name}", and ${swap.missing!.join(", ")} of it is not a public export of "${packageJson.name}". Add a rule for ${toPosix(path.relative(dir, resolved.id))}, or export it from the package.`,
      );
      return;
    }

    addDependency(module, resolved.registry.packageJson.name!, start);
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

  // --- generate stage

  function render(module: Module) {
    const { registry, file, edits, output } = module;
    const scanned = scanFile(file);
    if (!scanned) {
      registry.output.files.set(module.path, fs.readFileSync(file));
      return;
    }

    const { code, stmts } = scanned;
    edits.sort((a, b) => a.start - b.start);
    let out = "";
    let last = 0;
    for (const edit of edits) {
      out += code.slice(last, edit.start);
      if (edit.link) {
        (output.imports ??= []).push({
          ...edit.link,
          start: out.length,
        });
      }
      out += edit.text;
      last = edit.end;
    }
    registry.output.files.set(module.path, out + code.slice(last));
    if (!stmts) return;

    // edits are inside statements
    let delta = 0;
    let i = 0;
    for (const stmt of stmts) {
      for (; i < edits.length && edits[i].start < stmt.end; i++) {
        delta += edits[i].text.length - (edits[i].end - edits[i].start);
      }
      stmt.end += delta;
    }
    output.stmtInfos = stmts;
  }

  const output = scanRegistry(root);

  // modules are appended on the way
  for (const module of modules.values()) {
    const result = scanFile(module.file);
    if (!result) continue;
    for (const record of result.imports) linkImport(module, record, result.code[record.start - 1]);
  }

  if (errors.length > 0) throw new Error(errors.join("\n\n"));

  for (const module of modules.values()) render(module);
  return output;
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
