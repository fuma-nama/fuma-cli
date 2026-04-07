import path from "node:path";
import fs from "node:fs/promises";
import type { CompileContext, Reference, Registry } from "./compile";
import { parse, type ParseResult } from "oxc-parser";
import { visitSpecifiers } from "@/utils/ast";
import { MACRO_PATH } from "@/constants";
import { ResolverFactory } from "oxc-resolver";
import type { PackageJson } from "@/types";

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

// absolute path -> info
export type PackageJsonMap = Map<string, { data: PackageJson | null; registry: Registry }>;

export async function resolveFiles(ctx: CompileContext) {
  const { root, fileGraph } = ctx;
  // resolve anything possible
  const oxc = new ResolverFactory({
    extensions: [".js", ".jsx", ".ts", ".tsx", ".node"],
    conditionNames: ["node", "import", "require", "default", "types"],
    tsconfig: "auto",
  });

  // absolute path -> info
  const packageJsons: PackageJsonMap = new Map();

  async function findRegistryPackageJsons(registry: Registry) {
    const packageJson = path.join(registry.dir, registry.packageJson);
    if (packageJsons.has(packageJson)) return;

    packageJsons.set(packageJson, {
      data: await fs
        .readFile(packageJson)
        .then((res) => JSON.parse(res.toString()) as PackageJson)
        .catch(() => null),
      registry,
    });

    if (registry.subRegistries)
      await Promise.all(registry.subRegistries.map(findRegistryPackageJsons));
  }

  await findRegistryPackageJsons(root);

  await Promise.all(
    Array.from(fileGraph.vertices()).map((file) => resolveFile(file, oxc, packageJsons, ctx)),
  );

  return { packageJsons };
}

async function resolveFile(
  filePath: string,
  oxc: ResolverFactory,
  packageJsons: PackageJsonMap,
  ctx: CompileContext,
) {
  const { fileGraph, onUnknownFile, isExternal, onParseReference } = ctx;
  let node = fileGraph.getVertex(filePath);

  if (!node) throw new Error(`vertex "${filePath}" should exist before resolving`);
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
  const content = node.resolved.content ?? (await fs.readFile(filePath)).toString();

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
    } else if (!packageJsons.has(resolvedSpecifier.packageJsonPath)) {
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

  await Promise.all(next.map((ref) => resolveFile(ref, oxc, packageJsons, ctx)));
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
