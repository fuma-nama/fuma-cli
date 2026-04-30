import path from "node:path";
import fs from "node:fs/promises";
import type { CompileContext, Reference } from "./compile";
import { parse, type ParseResult } from "oxc-parser";
import { visitSpecifiers } from "@/utils/ast";
import { MACRO_PATH } from "@/constants";
import { ResolverFactory } from "oxc-resolver";
import { ChunkType, getFileGroupComponentName } from "./chunks";

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
      imports?: Map<string, Reference>;
      content: string;
      ast: ParseResult;
    }
  | {
      type: "resolving";
    };

export async function resolveFiles(ctx: CompileContext) {
  const { fileGraph } = ctx;
  // resolve anything possible
  const oxc = new ResolverFactory({
    extensions: [".js", ".jsx", ".ts", ".tsx", ".node"],
    conditionNames: ["node", "import", "require", "default", "types"],
    tsconfig: "auto",
  });

  await Promise.all(Array.from(fileGraph.vertices()).map((file) => resolveFile(file, oxc, ctx)));
}

async function resolveFile(filePath: string, oxc: ResolverFactory, ctx: CompileContext) {
  const {
    fileGraph,
    _registryPackageJsonPaths,
    options: { onUnknownFile, isExternal, onParseReference },
  } = ctx;
  let node = fileGraph.getVertex(filePath)!;
  if (node.scanned) return;

  node.scanned = {
    type: "resolving",
  };

  const astTypes: Record<string, "js" | "ts" | undefined> = {
    ".ts": "ts",
    ".tsx": "ts",
    ".js": "js",
    ".jsx": "js",
  };
  const astType = astTypes[path.extname(filePath)];
  const content = node.resolved.content ?? (await fs.readFile(filePath, "utf-8"));

  if (!astType) {
    node.scanned = {
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

  let imports: Map<string, Reference> | undefined;
  const next: string[] = [];

  visitSpecifiers(ast.program, (source) => {
    const specifier = source.value;
    let resolved: Reference | undefined;
    const resolvedSpecifier = oxc.resolveFileSync(filePath, specifier);

    if (resolvedSpecifier.error || !resolvedSpecifier.path || !resolvedSpecifier.packageJsonPath) {
      resolved = {
        type: "unknown",
        specifier,
      };
    } else if (!_registryPackageJsonPaths.has(resolvedSpecifier.packageJsonPath)) {
      // outside of registry dir = dep
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

    if (onParseReference) {
      resolved = onParseReference(resolved, { filePath });
    }

    if (resolved.type === "file") {
      if (!fileGraph.hasVertex(resolved.file)) {
        const out = onUnknownFile?.(resolved.file);

        if (out) {
          fileGraph.addVertex(resolved.file, { resolved: out });
        } else if (out === false) {
          // skip this import
          return;
        } else {
          throw new Error(
            `Unknown file: "${resolved.file}", no info on how the file should be handled. Please define onUnknownFile() on registry-level, or include it in your component.`,
          );
        }
      }

      fileGraph.addEdge(filePath, resolved.file);
      next.push(resolved.file);
    }

    imports ??= new Map();
    imports.set(specifier, resolved);
  });

  node.scanned = {
    type: "ts",
    ast,
    content,
    imports,
  };

  await Promise.all(next.map((ref) => resolveFile(ref, oxc, ctx)));
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

/** resolve files again after chunk generation */
export function resolveChunks(ctx: CompileContext) {
  const {
    fileGraph,
    options: { root },
  } = ctx;

  for (const { data } of fileGraph.values()) {
    const scanned = data.scanned!;

    if (scanned.type === "ts" && scanned.imports) {
      for (const [k, meta] of scanned.imports.entries()) {
        if (meta.type !== "file") continue;

        const importedFile = fileGraph.getVertex(meta.file);
        if (!importedFile || !importedFile.chunk) continue;

        scanned.imports.set(k, {
          type: "sub-component",
          resolved: {
            type: "local",
            subRegistry:
              importedFile.chunk.type === ChunkType.Component &&
              importedFile.chunk.registry !== root
                ? importedFile.chunk.registry.name
                : undefined,
            component:
              importedFile.chunk.type === ChunkType.Group
                ? getFileGroupComponentName(importedFile.chunk)
                : importedFile.chunk.component.name,
            file: importedFile.resolved,
          },
        });
      }
    }
  }
}
