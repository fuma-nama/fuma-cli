import type { Import, Symbol } from "yuku-analyzer";
import type { StmtInfo } from "@/registry/schema";
import { SCRIPT_EXTS } from "@/constants";
import { analyzeFile } from "@/utils/analyze";
import { scanStmts } from "./stmt";

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
  /** differs from the input when tree-shaken */
  code: string;
  /** defined when tree-shaken */
  stmts?: StmtInfo[];
  imports: ImportRecord[];
  exports: ExportRecord[];
}

export function isScannable(ext: string): boolean {
  return SCRIPT_EXTS.includes(ext);
}

/**
 * It reads the import & export records of analyzer, AST nodes are only decoded for their spans.
 *
 * @param treeshake - rewrite import declarations to have one binding each, and analyze statements
 */
export function scan(file: string, code: string, treeshake = false): ScanResult {
  const module = analyzeFile(file, code);
  // specifier start -> import
  const imports = new Map<number, ImportRecord>();
  const exports: ExportRecord[] = [];
  const importOf = new Map<Symbol, Import>();

  /** @param name - `undefined` for the whole module */
  function addImport(
    kind: ImportKind,
    source: { start: number; end: number },
    name?: string,
  ): ImportRecord {
    let record = imports.get(source.start);
    if (!record) {
      const start = source.start + 1;
      const end = source.end - 1;
      record = { kind, specifier: code.slice(start, end), start, end, bindings: [] };
      imports.set(source.start, record);
    }

    if (name === undefined || name === "*") record.bindings = undefined;
    else record.bindings?.push(name);
    return record;
  }

  for (const item of module.imports) {
    const { node } = item;
    if (node.type === "ImportExpression") {
      addImport("dynamic-import", node.source);
      continue;
    }

    const declaration = item.isSideEffect ? node : module.parentOf(node);
    if (declaration?.type !== "ImportDeclaration") continue;
    const imported = item.isSideEffect ? undefined : (item.name ?? "*");
    const record = addImport("import-statement", declaration.source, imported);
    record.declaration ??= { start: declaration.start, end: declaration.end, bindings: [] };
    if (imported === undefined) continue;

    importOf.set(item.local!, item);
    record.declaration.bindings.push({
      imported,
      local: item.local!.name,
      isType: item.typeOnly,
    });
  }

  if (treeshake) {
    let out = "";
    let last = 0;
    for (const { start, declaration } of imports.values()) {
      if (!declaration || declaration.bindings.length < 2) continue;
      const from = ` from ${code.slice(start - 1, declaration.end)}`;
      out += code.slice(last, declaration.start);
      last = declaration.end;

      for (let i = 0; i < declaration.bindings.length; i++) {
        const { imported, local, isType } = declaration.bindings[i];
        let clause = local;
        if (imported === "*") clause = `* as ${local}`;
        else if (imported !== "default") {
          clause = imported === local ? `{ ${local} }` : `{ ${imported} as ${local} }`;
        }
        out += `${i > 0 ? "\n" : ""}import ${isType ? "type " : ""}${clause}${from}`;
      }
    }
    if (last > 0) return scan(file, out + code.slice(last), true);
  }

  for (const item of module.exports) {
    const name = item.isStar ? "*" : item.name!;
    if (item.specifier === null) {
      // `import { a } from "x"; export { a }`
      const origin = item.local && importOf.get(item.local);
      exports.push(
        origin
          ? { name, from: { specifier: origin.specifier, name: origin.name ?? "*" } }
          : { name },
      );
      continue;
    }

    const fromName = item.fromName ?? "*";
    const declaration =
      item.node.type === "ExportAllDeclaration" ? item.node : module.parentOf(item.node);
    exports.push({ name, from: { specifier: item.specifier, name: fromName } });
    if (
      declaration?.type === "ExportAllDeclaration" ||
      declaration?.type === "ExportNamedDeclaration"
    )
      addImport("import-statement", declaration.source!, fromName);
  }

  // new URL("./file", import.meta.url)
  if (module.moduleFlags.usesImportMeta) {
    module.walk({
      NewExpression({ callee, arguments: [url, base] }) {
        if (
          callee.type === "Identifier" &&
          callee.name === "URL" &&
          url?.type === "Literal" &&
          typeof url.value === "string" &&
          base?.type === "MemberExpression" &&
          base.object.type === "MetaProperty"
        ) {
          addImport("new-url", url);
        }
      },
    });
  }

  return {
    code,
    stmts: treeshake ? scanStmts(module, code) : undefined,
    imports: Array.from(imports.values()),
    exports,
  };
}
