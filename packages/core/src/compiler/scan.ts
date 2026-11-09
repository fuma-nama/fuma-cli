import type { Node } from "@babel/types";
import type { StmtInfo } from "@/registry/schema";
import { SCRIPT_EXTS } from "@/constants";
import { nameOf, parseFile, scanStatement } from "@/utils/parse";
import { scanStmts, walk } from "./stmt";

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
 * @param treeshake - rewrite import declarations to have one binding each, and analyze statements
 */
export function scan(file: string, code: string, treeshake = false): ScanResult {
  const ast = parseFile(file, code);
  // specifier start -> import
  const imports = new Map<number, ImportRecord>();
  const exports: ExportRecord[] = [];
  // local name -> what it imports
  const importOf = new Map<string, NonNullable<ExportRecord["from"]>>();

  /** @param name - `undefined` for the whole module */
  function addImport(kind: ImportKind, source: Node, name?: string): ImportRecord {
    let record = imports.get(source.start!);
    if (!record) {
      const start = source.start! + 1;
      const end = source.end! - 1;
      record = { kind, specifier: code.slice(start, end), start, end, bindings: [] };
      imports.set(source.start!, record);
    }

    if (name === undefined || name === "*") record.bindings = undefined;
    else record.bindings?.push(name);
    return record;
  }

  for (const stmt of ast.program.body) {
    if (stmt.type !== "ImportDeclaration") continue;
    const declaration = { start: stmt.start!, end: stmt.end!, bindings: [] };
    if (stmt.specifiers.length === 0) {
      addImport("import-statement", stmt.source).declaration ??= declaration;
      continue;
    }

    for (const spec of stmt.specifiers) {
      let imported = "*";
      if (spec.type === "ImportDefaultSpecifier") imported = "default";
      else if (spec.type === "ImportSpecifier") imported = nameOf(spec.imported);
      const record = addImport("import-statement", stmt.source, imported);
      record.declaration ??= declaration;
      importOf.set(spec.local.name, { specifier: record.specifier, name: imported });
      record.declaration.bindings.push({
        imported,
        local: spec.local.name,
        isType:
          stmt.importKind === "type" ||
          (spec.type === "ImportSpecifier" && spec.importKind === "type"),
      });
    }
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

  for (const stmt of ast.program.body) {
    if (stmt.type === "ExportAllDeclaration") {
      exports.push({ name: "*", from: { specifier: stmt.source.value, name: "*" } });
      addImport("import-statement", stmt.source);
    } else if (stmt.type === "ExportNamedDeclaration" && stmt.source) {
      for (const spec of stmt.specifiers) {
        const fromName = spec.type === "ExportSpecifier" ? nameOf(spec.local) : "*";
        exports.push({
          name: nameOf(spec.exported),
          from: { specifier: stmt.source.value, name: fromName },
        });
        addImport("import-statement", stmt.source, fromName);
      }
    } else if (stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration") {
      // `import { a } from "x"; export { a }`
      const locals = new Map<string, string>();
      if (stmt.type === "ExportDefaultDeclaration") {
        if (stmt.declaration.type === "Identifier") locals.set("default", stmt.declaration.name);
      } else {
        for (const spec of stmt.specifiers) {
          if (spec.type === "ExportSpecifier")
            locals.set(nameOf(spec.exported), nameOf(spec.local));
        }
      }

      const names = new Set<string>();
      scanStatement(stmt, new Set(), names);
      for (const name of names) {
        const local = locals.get(name);
        const origin = local === undefined ? undefined : importOf.get(local);
        exports.push(origin ? { name, from: origin } : { name });
      }
    }
  }

  walk(ast.program, (node) => {
    if (
      node.type === "ImportExpression" &&
      (node.source.type === "StringLiteral" ||
        (node.source.type === "TemplateLiteral" && node.source.expressions.length === 0))
    ) {
      addImport("dynamic-import", node.source);
      return;
    }

    // new URL("./file", import.meta.url)
    if (node.type !== "NewExpression") return;
    const [url, base] = node.arguments;
    if (
      node.callee.type === "Identifier" &&
      node.callee.name === "URL" &&
      url?.type === "StringLiteral" &&
      base?.type === "MemberExpression" &&
      base.object.type === "MetaProperty"
    ) {
      addImport("new-url", url);
    }
  });

  return {
    code,
    stmts: treeshake ? scanStmts(ast, code) : undefined,
    imports: Array.from(imports.values()),
    exports,
  };
}
