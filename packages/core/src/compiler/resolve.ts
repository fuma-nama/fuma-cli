import path from "node:path";
import fs from "node:fs/promises";
import type { CompileContext, Reference } from "./compile";
import { parse, type ParseResult } from "oxc-parser";
import { visitSpecifiers } from "@/utils/ast";
import { MACRO_PATH } from "@/constants";

export type RawReference =
  | {
      type: "file";
      /**
       * Absolute path
       */
      file: string;
    }
  | {
      type: "dependency";
      dep: string;
      specifier: string;
    }
  | {
      type: "unknown";
      specifier: string;
    };

export type ScanResult =
  | {
      type: "raw";
      content: string;
    }
  | {
      type: "ts";
      imports?: Map<string, RawReference>;
      content: string;
      ast: ParseResult;
    }
  | {
      type: "resolving";
    };

export async function resolveFiles(prescannedFilePaths: string[], ctx: CompileContext) {
  await Promise.all(prescannedFilePaths.map((filePath) => resolveFile(filePath, ctx)));
}

async function resolveFile(filePath: string, ctx: CompileContext) {
  const { fileGraph, registry, resolver, onUnknownFile, isExternal } = ctx;
  let node = fileGraph.getVertex(filePath);

  if (!node) throw new Error(`vertex "${filePath}" should exist before resolving`);
  if (node.data.scanned) return;

  node.data.scanned = {
    type: "resolving",
  };

  if (!node.data.resolved) {
    const out = await onUnknownFile?.(filePath);

    if (out === false) {
      fileGraph.removeVertex(filePath);
      return;
    } else if (!out) {
      throw new Error(
        `Unknown file: "${filePath}", no info on how the file should be handled. Please define onUnknownFile() on registry-level, or include it in your component.`,
      );
    }

    node.data.resolved = out;
  }

  const astTypes: Record<string, "js" | "ts" | undefined> = {
    ".ts": "ts",
    ".tsx": "ts",
    ".js": "js",
    ".jsx": "js",
  };
  const astType = astTypes[path.extname(filePath)];
  const content = (await fs.readFile(filePath)).toString();

  if (!astType) {
    node.data.scanned = {
      type: "raw",
      content,
    };
    return;
  }

  const ast = await parse(filePath, content, {
    astType,
  });

  if (ast.errors.length > 0) {
    throw new Error(`failed to parse file ${filePath}: \n${ast.errors.join("\n")}`);
  }

  const scanned: ScanResult = (node.data.scanned = {
    type: "ts",
    ast,
    content,
  });

  const next: string[] = [];
  visitSpecifiers(ast.program, (source) => {
    const specifier = source.value;
    let resolved: Reference | undefined;
    const resolvedSpecifier = resolver.oxc.resolveFileSync(filePath, specifier);

    if (resolvedSpecifier.error || !resolvedSpecifier.path) {
      resolved = {
        type: "unknown",
        specifier,
      };
    } else if (path.relative(registry.dir, resolvedSpecifier.path).startsWith(`..${path.sep}`)) {
      // outside of registry dir
      resolved = {
        type: "dependency",
        dep: getDepFromSpecifier(specifier)!,
        specifier,
      };
    } else {
      resolved = {
        type: "file",
        file: resolvedSpecifier.path,
      };
    }

    if ((isExternal && isExternal(resolved)) || isExternalDefault(resolved)) return;

    scanned.imports ??= new Map();
    scanned.imports.set(specifier, resolved);
    if (resolved.type === "file") {
      fileGraph.addVertex(resolved.file, {});
      fileGraph.addEdge(filePath, resolved.file);
      next.push(resolved.file);
    }
  });

  await Promise.all(next.map((ref) => resolveFile(ref, ctx)));
}

function isExternalDefault(ref: RawReference) {
  switch (ref.type) {
    case "unknown":
      return ref.specifier.startsWith("node:");
    case "dependency":
      return ref.specifier.startsWith(MACRO_PATH);
    default:
      return false;
  }
}

function getDepFromSpecifier(specifier: string) {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}
