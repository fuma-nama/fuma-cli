import path from "node:path";
import { typescriptExtensions } from "@/constants";
import { type Program, Visitor } from "oxc-parser";
import type MagicString from "magic-string";
import type {
  ImportDeclaration,
  ImportDeclarationSpecifier,
  StringLiteral,
} from "@oxc-project/types";

/**
 * Return the import specifier for `sourceFile` to import `referenceFile`
 */
export function toImportSpecifier(sourceFile: string, referenceFile: string): string {
  const extname = path.extname(referenceFile);
  const removeExt = typescriptExtensions.includes(extname);

  let importPath = path
    .relative(
      path.dirname(sourceFile),
      removeExt ? referenceFile.substring(0, referenceFile.length - extname.length) : referenceFile,
    )
    .replaceAll(path.sep, "/");

  if (removeExt && importPath.endsWith("/index")) {
    importPath = importPath.slice(0, -"/index".length);
  }

  return importPath.startsWith("../") ? importPath : `./${importPath}`;
}

export function visitSpecifiers(program: Program, specifier: (node: StringLiteral) => void) {
  new Visitor({
    // static imports
    ImportDeclaration(node) {
      const source = node.source;
      specifier(source);
    },
    // dynamic imports
    ImportExpression(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        specifier(node.source);
      }
    },
    // exports
    ExportAllDeclaration(node) {
      const source = node.source;
      specifier(source);
    },
    ExportNamedDeclaration(node) {
      if (node.source) specifier(node.source);
    },
  }).visit(program);
}

export function transformSpecifiers(
  program: Program,
  s: MagicString,
  transformSpecifier: (value: string) => string | undefined,
) {
  visitSpecifiers(program, (node) => {
    const out = transformSpecifier(node.value);
    if (out) {
      s.update(node.start + 1, node.end - 1, out);
    }
  });
}

function getImportedBinding(
  spec: ImportDeclarationSpecifier,
): { imported: string; local: string } | null {
  if (spec.type === "ImportSpecifier") {
    let imported: string;
    switch (spec.imported.type) {
      case "Identifier":
        imported = spec.imported.name;
        break;
      case "Literal":
        imported = spec.imported.value;
        break;
    }

    return {
      imported,
      local: spec.local.name,
    };
  }
  if (spec.type === "ImportDefaultSpecifier") {
    return { imported: "default", local: spec.local.name };
  }
  return null;
}

export function collectMacroBindings(
  program: Program,
  name: string,
): { importDecls: ImportDeclaration[]; locals: Set<string> } | null {
  const locals = new Set<string>();
  const importDecls: ImportDeclaration[] = [];
  const seenDecl = new Set<ImportDeclaration>();

  new Visitor({
    ImportDeclaration(node: ImportDeclaration) {
      for (const spec of node.specifiers) {
        const b = getImportedBinding(spec);
        if (!b || b.imported !== name) continue;

        locals.add(b.local);

        if (!seenDecl.has(node)) {
          seenDecl.add(node);
          importDecls.push(node);
        }
      }
    },
  }).visit(program);

  if (locals.size === 0) return null;
  return { importDecls, locals };
}
