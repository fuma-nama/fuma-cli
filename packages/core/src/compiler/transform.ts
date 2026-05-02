import { encodeImport, getComponentFileId } from "@/protocols/import";
import type {
  CompiledComponent,
  CompiledFile,
  CompiledIndex,
  subComponentReference,
} from "@/registry/schema";
import { transformSpecifiers } from "@/utils/ast";
import MagicString from "magic-string";
import z from "zod";
import type { CompileContext, Component, Reference, Registry } from "./compile";
import { Chunk, ChunkType } from "./chunks";
import { type DepInfo, resolveDepInfo } from "./deps";

export interface TransformFileContext extends CompileContext {
  chunk: Chunk;
  component: Component;
  dependencies: Record<string, string | null>;
  devDependencies: Record<string, string | null>;
  subComponents: Map<string, z.input<typeof subComponentReference>>;
}

export function writeChunks(ctx: CompileContext) {
  const {
    fileGraph,
    registryMap,
    chunks,
    options: { root },
  } = ctx;
  const chunkFiles = new Map<Chunk, string[]>();
  for (const chunk of chunks) {
    chunkFiles.set(chunk, []);
  }

  for (const [file, node] of fileGraph.entries()) {
    chunkFiles.get(node.data.chunk!)!.push(file);
  }

  for (const [chunk, files] of chunkFiles.entries()) {
    const registry = chunk.type === ChunkType.Group ? root : chunk.registry;
    const { output } = registryMap.get(registry.name)!;

    const [comp, index, unlisted] = transformComponent(registry, chunk, files, ctx);
    if (unlisted) {
      output.info.unlistedIndexes.push(index);
    } else {
      output.info.indexes.push(index);
    }

    output.components.push(comp);
  }
}

function transformComponent(
  registry: Registry,
  chunk: Chunk,
  filePaths: string[],
  ctx: CompileContext,
): [CompiledComponent, CompiledIndex, unlisted: boolean] {
  const component =
    chunk.type === ChunkType.Component
      ? chunk.component
      : {
          name: chunk.componentName,
          files: [],
          unlisted: true,
        };
  const fileCtx: TransformFileContext = {
    ...ctx,
    chunk,
    component,
    dependencies: { ...registry.dependencies, ...component.dependencies },
    devDependencies: { ...registry.devDependencies, ...component.devDependencies },
    subComponents: new Map(),
  };
  const files = filePaths.map((file) => transformFile(file, fileCtx));
  if (component.subComponents) {
    for (const v of component.subComponents) {
      fileCtx.subComponents.set(hashSubComponentReference(v), v);
    }
  }

  return [
    {
      name: component.name,
      title: component.title,
      description: component.description,
      files,
      subComponents: Array.from(fileCtx.subComponents.values()),
      dependencies: fileCtx.dependencies,
      devDependencies: fileCtx.devDependencies,
      meta: component.meta,
    },
    {
      name: component.name,
      description: component.description,
      title: component.title,
    },
    component.unlisted ?? false,
  ];
}

function hashSubComponentReference(ref: z.input<typeof subComponentReference>): string {
  if (typeof ref === "string") return ref;
  if (ref.type === "sub-registry") {
    return `sub-registry:${ref.subRegistry}:${ref.component}`;
  }
  return `http:${ref.registryUrl}:${ref.subRegistry ?? ""}:${ref.component}`;
}

function writeReference(reference: Reference, ctx: TransformFileContext) {
  const { fileGraph, chunk, registryMap, subComponents } = ctx;

  if (reference.type === "unknown") {
    console.warn(`Unknown specifier ${reference.specifier}, skipping for now`);
    return reference.specifier;
  }

  if (reference.type === "file") {
    const resolved = fileGraph.getVertex(reference.file)?.resolved;

    if (resolved) {
      return encodeImport({ type: "local", fileId: getComponentFileId(resolved) });
    }

    return;
  }

  if (reference.type === "sub-component") {
    const resolved = reference.resolved;

    if (resolved.type === "http") {
      const ref: z.input<typeof subComponentReference> = {
        type: "http",
        registryUrl: resolved.registryUrl,
        subRegistry: resolved.subRegistry,
        component: resolved.component,
      };

      subComponents.set(hashSubComponentReference(ref), ref);
      return encodeImport({
        type: "local",
        fileId: resolved.file,
      });
    }

    const ref: z.input<typeof subComponentReference> = resolved.subRegistry
      ? {
          type: "sub-registry",
          subRegistry: resolved.subRegistry,
          component: resolved.component,
        }
      : resolved.component;

    subComponents.set(hashSubComponentReference(ref), ref);
    return encodeImport({ type: "local", fileId: getComponentFileId(resolved.file) });
  }

  // already defined
  if (reference.dep in ctx.dependencies || reference.dep in ctx.devDependencies) {
    return reference.specifier;
  }

  // use fallback from `package.json`
  if (chunk.type === ChunkType.Component) {
    let depInfo: DepInfo | undefined;

    const r = registryMap.get(chunk.registry.name)!;
    depInfo = resolveDepInfo(reference.dep, r.packageJson);

    if (depInfo) {
      const map = depInfo.type === "dev" ? ctx.devDependencies : ctx.dependencies;
      map[depInfo.name] = depInfo.version;
    } else {
      console.warn(`dep info for ${reference.dep} cannot be found`);
    }
  }

  return reference.specifier;
}

function transformFile(file: string, ctx: TransformFileContext): CompiledFile {
  const {
    fileGraph,
    options: { beforeTransform, afterTransform },
  } = ctx;
  const { scanned, resolved } = fileGraph.getVertex(file)!;
  if (!scanned) throw new Error();

  if (scanned.type === "raw") {
    let content = scanned.content;
    if (beforeTransform) content = beforeTransform(content, file, ctx) ?? content;
    if (afterTransform) content = afterTransform(content, file, ctx) ?? content;
    return { ...resolved, content };
  }

  if (scanned.type === "ts") {
    let { content, imports, ast } = scanned;
    if (beforeTransform) content = beforeTransform(content, file, ctx) ?? content;

    const s = new MagicString(content);

    // Process import paths
    if (imports) {
      transformSpecifiers(ast.program, s, (specifier) => {
        const meta = imports.get(specifier);
        if (meta) return writeReference(meta, ctx);
      });
    }

    content = s.toString();
    if (afterTransform) content = afterTransform(content, file, ctx) ?? content;

    return {
      ...resolved,
      content,
    };
  }

  throw new Error(`unexpected file type: ${scanned.type}`);
}
