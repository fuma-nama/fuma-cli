import type { ImportRecord, ScanResult } from "./scan";

export interface PublicName {
  specifier: string;
  name: string;
}

export interface ExportIndex {
  /** entry file -> specifier */
  modules: Map<string, string>;
  /** `nameKey(file, name)` -> where the package exports it */
  names: Map<string, PublicName>;
}

interface Hop {
  file: string;
  name: string;
}

export function nameKey(file: string, name: string): string {
  return `${file}\0${name}`;
}

/**
 * Follow the re-exports of package entries, every module on the way to a declaration can be swapped for the entry.
 */
export function buildExportIndex(
  entries: Map<string, string>,
  scanFile: (file: string) => ScanResult | undefined,
  resolve: (specifier: string, from: string) => string | undefined,
): ExportIndex {
  // file -> export name -> hops from the file to the declaration
  const cache = new Map<string, Map<string, Hop[]>>();

  function exportsOf(file: string): Map<string, Hop[]> {
    let out = cache.get(file);
    if (out) return out;
    out = new Map();
    // set before visiting, circular re-exports see the partial result
    cache.set(file, out);

    const scanned = scanFile(file);
    if (!scanned) return out;
    const stars: string[] = [];

    for (const item of scanned.exports) {
      if (item.name === "*") {
        stars.push(item.from!.specifier);
        continue;
      }

      const hops: Hop[] = [{ file, name: item.name }];
      out.set(item.name, hops);
      if (!item.from || item.from.name === "*") continue;

      const target = resolve(item.from.specifier, file);
      const rest = target && exportsOf(target).get(item.from.name);
      if (rest) hops.push(...rest);
    }

    for (const specifier of stars) {
      const target = resolve(specifier, file);
      if (!target) continue;

      for (const [name, hops] of exportsOf(target)) {
        if (name === "default" || out.has(name)) continue;
        out.set(name, [{ file, name }, ...hops]);
      }
    }

    return out;
  }

  const index: ExportIndex = { modules: new Map(), names: new Map() };

  for (const [specifier, file] of entries) {
    if (!index.modules.has(file)) index.modules.set(file, specifier);

    for (const [name, hops] of exportsOf(file)) {
      for (const hop of hops) {
        const key = nameKey(hop.file, hop.name);
        if (!index.names.has(key)) index.names.set(key, { specifier, name });
      }
    }
  }

  return index;
}

/** an import of `specifier`, a rewritten `declaration`, or the bindings `missing` from the package */
export interface PackageImport {
  specifier?: string;
  declaration?: string;
  missing?: string[];
}

/**
 * @param file - the imported file
 * @returns the package import of `record`, or bindings that the package doesn't export.
 */
export function toPackageImport(
  index: ExportIndex,
  file: string,
  record: ImportRecord,
  quote: string,
): PackageImport {
  const entry = index.modules.get(file);
  if (entry) return { specifier: entry };
  if (!record.bindings) return { missing: ["*"] };

  const missing: string[] = [];
  let specifier: string | undefined;
  let renamed = false;
  for (const name of record.bindings) {
    const found = index.names.get(nameKey(file, name));
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
    const found = index.names.get(nameKey(file, binding.imported))!;
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
