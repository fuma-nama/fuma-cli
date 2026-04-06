import { encodeImport, getComponentFileId } from "@/registry/protocols/import";
import { CompiledComponent, CompiledFile, subComponentReference } from "@/registry/schema";
import { transformSpecifiers } from "@/utils/ast";
import MagicString from "magic-string";
import z from "zod";
import type { Component, Reference, TransformContext } from "./compile";
import { Chunk, ChunkType, fileGroupToComponent, getFileGroupComponentName } from "./chunks";
import { type DepInfo, resolveDepInfo } from "./deps";

export interface CompileComponentContext extends TransformContext {
  chunk: Chunk;
  component: Component;
  dependencies: Record<string, string | null>;
  devDependencies: Record<string, string | null>;
  subComponents: Map<string, z.input<typeof subComponentReference>>;
}

export function transformChunks(ctx: TransformContext) {
  const { chunkGraph, registryMap, root } = ctx;

  for (const chunk of chunkGraph.vertices()) {
    if (chunk.type === ChunkType.Group) {
      const { output } = registryMap.get(root.name)!;
      output.components.push(transformComponent(chunk, fileGroupToComponent(chunk), ctx));
    } else {
      const { output } = registryMap.get(chunk.registry.name)!;
      output.components.push(transformComponent(chunk, chunk.component, ctx));
    }
  }
}

function transformComponent(
  chunk: Chunk,
  component: Component,
  ctx: TransformContext,
): CompiledComponent {
  const { fileGraph } = ctx;
  const registry = chunk.type === ChunkType.Component ? chunk.registry : null;
  const compCtx: CompileComponentContext = {
    ...ctx,
    chunk,
    component,
    dependencies: { ...registry?.dependencies, ...component.dependencies },
    devDependencies: { ...registry?.devDependencies, ...component.devDependencies },
    subComponents: new Map(),
  };
  const files: CompiledFile[] = [];
  for (const file of fileGraph.vertices()) {
    const data = fileGraph.getVertex(file)!.data;
    if (data.chunk !== chunk) continue;

    files.push({
      ...data.resolved!,
      content: transformFile(file, compCtx),
    });
  }

  return {
    name: component.name,
    title: component.title,
    description: component.description,
    files,
    subComponents: Array.from(compCtx.subComponents.values()),
    dependencies: compCtx.dependencies,
    devDependencies: compCtx.devDependencies,
  };
}

function hashSubComponentReference(ref: z.input<typeof subComponentReference>): string {
  if (typeof ref === "string") return ref;
  if (ref.type === "sub-registry") {
    return `sub-registry:${ref.subRegistry}:${ref.component}`;
  }
  return `http:${ref.registryUrl}:${ref.subRegistry ?? ""}:${ref.component}`;
}

function writeReference(reference: Reference, ctx: CompileComponentContext) {
  const { fileGraph, chunk, packageJsons, subComponents } = ctx;

  if (reference.type === "unknown") {
    console.warn(`Unknown specifier ${reference.specifier}, skipping for now`);
    return reference.specifier;
  }

  if (reference.type === "file") {
    const resolved = fileGraph.getVertex(reference.file)?.data.resolved;

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

    for (const v of packageJsons.values()) {
      if (v.registry === chunk.registry) {
        if (v.data) depInfo = resolveDepInfo(reference.dep, v.data);
        break;
      }
    }

    if (depInfo) {
      const map = depInfo.type === "dev" ? ctx.devDependencies : ctx.dependencies;
      map[depInfo.name] = depInfo.version;
    } else {
      console.warn(`dep info for ${reference.dep} cannot be found`);
    }
  }

  return reference.specifier;
}

function transformFile(filePath: string, ctx: CompileComponentContext): string {
  const { fileGraph, root } = ctx;
  const node = fileGraph.getVertex(filePath)!.data;
  const scanned = node.scanned!;
  if (scanned.type === "raw") return scanned.content;
  if (scanned.type === "resolving") throw new Error("impossible");
  const { content, imports, ast } = scanned;

  const s = new MagicString(content);

  // Process import paths
  if (imports) {
    transformSpecifiers(ast.program, s, (specifier) => {
      let meta: Reference | undefined = imports.get(specifier);
      if (!meta) return;

      if (meta.type === "file") {
        const data = fileGraph.getVertex(meta.file)?.data;

        if (data && data.chunk && data.resolved)
          meta = {
            type: "sub-component",
            resolved: {
              type: "local",
              subRegistry:
                data.chunk.type === ChunkType.Component && data.chunk.registry !== root
                  ? data.chunk.registry.name
                  : undefined,
              component:
                data.chunk.type === ChunkType.Group
                  ? getFileGroupComponentName(data.chunk)
                  : data.chunk.component.name,
              file: data.resolved,
            },
          };
      }

      return writeReference(meta, ctx);
    });
  }

  return s.toString();
}
