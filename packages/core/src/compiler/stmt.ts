import type { File, Node } from "@babel/types";
import type { StmtInfo } from "@/registry/schema";
import { scanStatement } from "@/utils/parse";

/** @returns index of the statement at `pos` */
export function stmtAt(stmts: StmtInfo[], pos: number): number {
  let low = 0;
  let high = stmts.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (stmts[mid].end > pos) high = mid;
    else low = mid + 1;
  }
  return low;
}

export function walk(node: Node, enter: (node: Node, parent: Node, key: string) => void) {
  for (const key in node) {
    // positions, parser metadata and attached comments hold no child nodes
    if (key === "loc" || key === "extra" || key.endsWith("Comments")) continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    for (const child of Array.isArray(value) ? value : [value]) {
      if (typeof child?.type !== "string") continue;
      enter(child, node, key);
      walk(child, enter);
    }
  }
}

/**
 * Binding analysis of top-level statements.
 *
 * A statement references every top-level binding its identifiers name. Shadowing is not resolved,
 * so a local name that shadows a top-level binding only selects an extra statement.
 */
export function scanStmts({ program, comments }: File, code: string): StmtInfo[] {
  const body = [...program.directives, ...program.body];
  const stmts: StmtInfo[] = [];

  // spans partition the file: a statement owns the lines before it, up to the line of the previous statement
  let c = 0;
  for (let i = 0; i < body.length; i++) {
    const limit = body[i].start!;
    const nextLine = (pos: number) => {
      const idx = code.indexOf("\n", pos);
      return idx === -1 || idx > limit ? limit : idx;
    };

    let start = i === 0 ? 0 : nextLine(body[i - 1].end!);
    for (; comments && c < comments.length && comments[c].end! <= limit; c++) {
      const comment = comments[c];
      if (comment.start! < start && comment.end! > start) start = nextLine(comment.end!);
    }

    if (i > 0) stmts[i - 1].end = start;
    stmts.push({ end: code.length });
    if (body[i].type === "ImportDeclaration") stmts[i].import = true;
  }

  // a binding has several declarations when overloaded or merged
  const owners = new Map<string, number[]>();
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];
    if (stmt.type === "Directive") continue;
    const bindings = new Set<string>();
    const exported = new Set<string>();
    scanStatement(stmt, bindings, exported);

    for (const name of bindings) {
      const indices = owners.get(name);
      if (indices) indices.push(i);
      else owners.set(name, [i]);
    }
    const declares = new Set([...bindings, ...exported]);
    if (declares.size > 0) stmts[i].declares = Array.from(declares);
  }

  for (let i = 0; i < body.length; i++) {
    const references = new Set<number>();
    walk(body[i], (node, parent, key) => {
      if (node.type !== "Identifier" && node.type !== "JSXIdentifier") return;
      if (!isReference(parent, key)) return;
      for (const j of owners.get(node.name) ?? []) if (j !== i) references.add(j);
    });
    if (references.size > 0) stmts[i].references = Array.from(references);
  }
  return stmts;
}

/** whether an identifier at `parent[key]` may name a binding */
function isReference(parent: Node, key: string): boolean {
  switch (parent.type) {
    case "MemberExpression":
    case "OptionalMemberExpression":
    case "ObjectProperty":
    case "ObjectMethod":
    case "ClassProperty":
    case "ClassMethod":
    case "ClassAccessorProperty":
    case "TSPropertySignature":
    case "TSMethodSignature":
    case "TSDeclareMethod":
      return parent.computed || (key !== "property" && key !== "key");
    case "JSXMemberExpression":
      return key !== "property";
    case "TSQualifiedName":
      return key !== "right";
    case "ImportSpecifier":
      return key !== "imported";
    case "ExportSpecifier":
    case "ExportNamespaceSpecifier":
      return key !== "exported";
    case "JSXAttribute":
    case "JSXNamespacedName":
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "TSEnumMember":
      return false;
    default:
      return true;
  }
}
