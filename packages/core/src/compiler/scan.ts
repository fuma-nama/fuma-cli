import { parseSync } from "oxc-parser";

export type ImportKind = "import-statement" | "dynamic-import" | "new-url";

export interface ImportedBinding {
  /** `default`, `*` for namespace, or the imported name */
  imported: string;
  local: string;
  isType: boolean;
}

export interface ImportRecord {
  kind: ImportKind;
  specifier: string;
  /** span of specifier, quotes excluded */
  start: number;
  end: number;
  /** defined for import declarations, which can be regenerated */
  declaration?: { start: number; end: number; bindings: ImportedBinding[] };
  /** names taken from the module, `undefined` for the whole module */
  bindings?: string[];
}

export interface ExportRecord {
  /** `default`, `*` for `export * from`, or the exported name */
  name: string;
  from?: {
    specifier: string;
    /** `*` for the whole module */
    name: string;
  };
}

export interface ScanResult {
  imports: ImportRecord[];
  exports: ExportRecord[];
}

const LANGS: Record<string, "js" | "jsx" | "ts" | "tsx" | undefined> = {
  ".js": "js",
  ".mjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
};

const NEW_URL = /new\s+URL\(\s*(["'])([^"']+)\1\s*,\s*$/;

export function isScannable(ext: string): boolean {
  return ext in LANGS;
}

/**
 * The only place that touches a parser: it reads the module record without materializing the AST.
 */
export function scan(filePath: string, ext: string, code: string): ScanResult {
  const result = parseSync(filePath, code, { lang: LANGS[ext] });
  if (result.errors.length > 0) {
    throw new Error(
      `failed to parse ${filePath}:\n${result.errors.map((e) => e.message).join("\n")}`,
    );
  }

  const { staticImports, staticExports, dynamicImports, importMetas } = result.module;
  // specifier start -> import
  const imports = new Map<number, ImportRecord>();
  const exports: ExportRecord[] = [];

  for (const item of staticImports) {
    const bindings: ImportedBinding[] = [];
    const names: string[] = [];

    for (const entry of item.entries) {
      const imported =
        entry.importName.kind === "Name"
          ? entry.importName.name!
          : entry.importName.kind === "Default"
            ? "default"
            : "*";
      names.push(imported);
      bindings.push({ imported, local: entry.localName.value, isType: entry.isType });
    }

    imports.set(item.moduleRequest.start, {
      kind: "import-statement",
      specifier: item.moduleRequest.value,
      start: item.moduleRequest.start + 1,
      end: item.moduleRequest.end - 1,
      declaration: { start: item.start, end: item.end, bindings },
      bindings: names.length > 0 && !names.includes("*") ? names : undefined,
    });
  }

  for (const item of staticExports) {
    for (const entry of item.entries) {
      const name =
        entry.exportName.kind === "Name"
          ? entry.exportName.name!
          : entry.exportName.kind === "Default"
            ? "default"
            : "*";
      const request = entry.moduleRequest;
      if (!request) {
        exports.push({ name });
        continue;
      }

      const fromName = entry.importName.kind === "Name" ? entry.importName.name! : "*";
      exports.push({ name, from: { specifier: request.value, name: fromName } });

      // `import { a } from "x"; export { a }` shares the span of its import
      const existing = imports.get(request.start);
      if (!existing) {
        imports.set(request.start, {
          kind: "import-statement",
          specifier: request.value,
          start: request.start + 1,
          end: request.end - 1,
          bindings: fromName === "*" ? undefined : [fromName],
        });
      } else if (!existing.declaration) {
        if (fromName === "*") existing.bindings = undefined;
        else existing.bindings?.push(fromName);
      }
    }
  }

  for (const item of dynamicImports) {
    const { start, end } = item.moduleRequest;
    const quote = code[start];
    if ((quote !== '"' && quote !== "'") || code[end - 1] !== quote) continue;

    imports.set(start, {
      kind: "dynamic-import",
      specifier: code.slice(start + 1, end - 1),
      start: start + 1,
      end: end - 1,
    });
  }

  // new URL("./file", import.meta.url)
  for (const meta of importMetas) {
    if (!code.startsWith(".url", meta.end)) continue;
    const match = NEW_URL.exec(code.slice(Math.max(0, meta.start - 256), meta.start));
    if (!match) continue;

    const end = meta.start - (match[0].length - match[0].lastIndexOf(match[1]));
    imports.set(end, {
      kind: "new-url",
      specifier: match[2],
      start: end - match[2].length,
      end,
    });
  }

  return { imports: Array.from(imports.values()), exports };
}
