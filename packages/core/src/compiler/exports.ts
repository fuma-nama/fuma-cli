import type { ScanResult } from "./scan";

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
