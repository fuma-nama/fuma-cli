import type { Module, Symbol } from "yuku-analyzer";
import { analyzeFile } from "@/utils/analyze";
import type { StmtInfo } from "@/registry/schema";

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

/** Symbol analysis of top-level statements. */
export function scanStmts(module: Module, code: string): StmtInfo[] {
  const { body } = module.ast;
  const stmts: StmtInfo[] = [];

  // spans partition the file: a statement owns the lines before it, up to the line of the previous statement
  let c = 0;
  for (let i = 0; i < body.length; i++) {
    const limit = body[i].start;
    const nextLine = (pos: number) => {
      const idx = code.indexOf("\n", pos);
      return idx === -1 || idx > limit ? limit : idx;
    };

    let start = i === 0 ? 0 : nextLine(body[i - 1].end);
    for (; c < module.comments.length && module.comments[c].end <= limit; c++) {
      const comment = module.comments[c];
      if (comment.start < start && comment.end > start) start = nextLine(comment.end);
    }

    if (i > 0) stmts[i - 1].end = start;
    stmts.push({ end: code.length });
    if (body[i].type === "ImportDeclaration") stmts[i].import = true;
  }

  function declare(i: number, name: string) {
    const declares = (stmts[i].declares ??= []);
    if (!declares.includes(name)) declares.push(name);
  }

  // a symbol has several declarations when overloaded or merged
  const owners = new Map<Symbol, number[]>();
  for (const symbol of module.rootScope.bindings) {
    const indices: number[] = [];
    for (const node of symbol.declarations) {
      const i = stmtAt(stmts, node.start);
      if (!indices.includes(i)) indices.push(i);
      declare(i, symbol.name);
    }
    owners.set(symbol, indices);
  }

  for (const item of module.exports) {
    if (item.name) declare(stmtAt(stmts, item.node.start), item.name);
  }

  for (const ref of module.references) {
    const indices = ref.symbol && owners.get(ref.symbol);
    if (!indices) continue;
    const i = stmtAt(stmts, ref.node.start);
    const references = (stmts[i].references ??= []);
    for (const j of indices) if (j !== i && !references.includes(j)) references.push(j);
  }
  return stmts;
}

/**
 * @returns the top-level names of a file (export names included), and the position to insert imports at.
 */
export function scanDeclared(
  file: string,
  code: string,
): { names: Set<string>; importEnd: number } {
  const module = analyzeFile(file, code);
  const names = new Set(module.exportedNames());
  for (const symbol of module.rootScope.bindings) names.add(symbol.name);

  let importEnd = 0;
  for (const stmt of module.ast.body) {
    if (
      stmt.type === "ImportDeclaration" ||
      (stmt.type === "ExpressionStatement" && stmt.directive)
    )
      importEnd = stmt.end;
  }
  return { names, importEnd };
}
