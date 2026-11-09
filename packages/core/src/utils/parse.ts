import { parse, type ParserPlugin } from "@babel/parser";
import type { File, Identifier, Node, PatternLike, Statement, StringLiteral } from "@babel/types";

/** the only place that touches the parser, it is pure JavaScript so CLIs can bundle the installer */
export function parseFile(file: string, code: string): File {
  const plugins: ParserPlugin[] = [];
  if (/\.[cm]?tsx?$/.test(file)) plugins.push("typescript");
  // `<T>value` is a type assertion in `.ts` files
  if (!/\.[cm]?ts$/.test(file)) plugins.push("jsx");

  try {
    return parse(code, { sourceType: "module", plugins });
  } catch (e) {
    throw new Error(`failed to parse ${file}: ${e instanceof Error ? e.message : e}`, {
      cause: e,
    });
  }
}

/**
 * @returns the top-level names of a file (export names included), and the position to insert imports at.
 */
export function scanDeclared(
  file: string,
  code: string,
): { names: Set<string>; importEnd: number } {
  const { program } = parseFile(file, code);
  const names = new Set<string>();
  let importEnd = 0;
  for (const directive of program.directives) importEnd = directive.end!;

  for (const stmt of program.body) {
    if (stmt.type === "ImportDeclaration") importEnd = stmt.end!;
    scanStatement(stmt, names, names);
  }
  return { names, importEnd };
}

/** adds the top-level bindings a statement declares, and the names it exports */
export function scanStatement(stmt: Statement, bindings: Set<string>, exported: Set<string>) {
  switch (stmt.type) {
    case "ImportDeclaration":
      for (const spec of stmt.specifiers) bindings.add(spec.local.name);
      break;
    case "ExportNamedDeclaration":
      for (const spec of stmt.specifiers) exported.add(nameOf(spec.exported));
      if (stmt.declaration) {
        declare(stmt.declaration, bindings);
        declare(stmt.declaration, exported);
      }
      break;
    case "ExportDefaultDeclaration":
      exported.add("default");
      declare(stmt.declaration, bindings);
      break;
    default:
      declare(stmt, bindings);
  }
}

export function nameOf(node: Identifier | StringLiteral): string {
  return node.type === "Identifier" ? node.name : node.value;
}

function declare(node: Node, names: Set<string>) {
  switch (node.type) {
    case "VariableDeclaration":
      for (const { id } of node.declarations) declarePattern(id, names);
      break;
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "TSDeclareFunction":
      if (node.id) names.add(node.id.name);
      break;
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
    case "TSEnumDeclaration":
    case "TSImportEqualsDeclaration":
      names.add(node.id.name);
      break;
    case "TSModuleDeclaration":
      // `declare module "x"` and `declare global` bind no name
      if (node.kind !== "global" && node.id.type === "Identifier") names.add(node.id.name);
      break;
  }
}

function declarePattern(node: PatternLike | Node, names: Set<string>) {
  switch (node.type) {
    case "Identifier":
      names.add(node.name);
      break;
    case "ObjectPattern":
      for (const prop of node.properties) {
        declarePattern(prop.type === "RestElement" ? prop.argument : prop.value, names);
      }
      break;
    case "ArrayPattern":
      for (const element of node.elements) if (element) declarePattern(element, names);
      break;
    case "AssignmentPattern":
      declarePattern(node.left, names);
      break;
    case "RestElement":
      declarePattern(node.argument, names);
      break;
  }
}
