import { encodeImport, getComponentFileId } from "@/protocols/import";
import {
  type CompiledComponent,
  type CompiledFile,
  type CompiledIndex,
  subComponentReference,
} from "@/registry/schema";
import { transformSpecifiers } from "@/utils/ast";
import MagicString from "magic-string";
import z from "zod";
import type { Component, FileGraphInfo, Reference, Registry, TransformContext } from "./compile";
import { Chunk, ChunkType, fileGroupToComponent, getFileGroupComponentName } from "./chunks";
import { type DepInfo, resolveDepInfo } from "./deps";

export interface CompileComponentContext extends TransformContext {
  chunk: Chunk;
  component: Component;
  dependencies: Record<string, string | null>;
  devDependencies: Record<string, string | null>;
  subComponents: Map<string, z.input<typeof subComponentReference>>;
}

export function writechunks(ctx: TransformContext) {
  const { fileGraph, registryMap, root } = ctx;
  const chunkFiles = new Map<Chunk, string[]>();

  for (const [file, node] of fileGraph.entries()) {
    const chunk = node.data.chunk;
    if (!chunk) throw new Error(`file "${file}" has no aligned chunk`);

    let list = chunkFiles.get(chunk);
    if (!list) {
      list = [];
      chunkFiles.set(chunk, list);
    }

    list.push(file);
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
  ctx: TransformContext,
): [CompiledComponent, CompiledIndex, unlisted: boolean] {
  const { fileGraph } = ctx;
  const component =
    chunk.type === ChunkType.Component ? chunk.component : fileGroupToComponent(chunk);
  const compCtx: CompileComponentContext = {
    ...ctx,
    chunk,
    component,
    dependencies: { ...registry.dependencies, ...component.dependencies },
    devDependencies: { ...registry.devDependencies, ...component.devDependencies },
    subComponents: new Map(),
  };
  const files: CompiledFile[] = filePaths.map((file) => {
    const data = fileGraph.getVertex(file)!;

    return {
      ...data.resolved,
      content: transformFile(data, compCtx),
    };
  });

  return [
    {
      name: component.name,
      title: component.title,
      description: component.description,
      files,
      subComponents: Array.from(compCtx.subComponents.values()),
      dependencies: compCtx.dependencies,
      devDependencies: compCtx.devDependencies,
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

function writeReference(reference: Reference, ctx: CompileComponentContext) {
  const { fileGraph, chunk, packageJsons, subComponents } = ctx;

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

function transformFile(data: FileGraphInfo, ctx: CompileComponentContext): string {
  const { fileGraph, root } = ctx;
  const scanned = data.scanned!;
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
        const data = fileGraph.getVertex(meta.file);

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
