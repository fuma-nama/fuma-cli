import { encodeImport, getComponentFileId } from "@/registry/protocols/import";
import { CompiledComponent, CompiledFile, subComponentReference } from "@/registry/schema";
import { transformSpecifiers } from "@/utils/ast";
import MagicString from "magic-string";
import z from "zod";
import type { Component, CompileContext, Reference, TransformCompileContext } from "./compile";
import { isChunk } from "./chunks";

export interface CompileComponentContext extends CompileContext {
  component: Component;
  dependencies: Record<string, string | null>;
  devDependencies: Record<string, string | null>;
  subComponents: Map<string, z.input<typeof subComponentReference>>;
}

export function transformComponent(
  component: Component,
  compileContext: TransformCompileContext,
): CompiledComponent {
  const { fileGraph, chunkGraph } = compileContext;
  const ctx: CompileComponentContext = {
    ...compileContext,
    component,
    dependencies: {},
    devDependencies: {},
    subComponents: new Map(),
  };
  const files: CompiledFile[] = [];
  for (const file of fileGraph.vertices()) {
    const data = fileGraph.getVertex(file)!.data;
    if (data.chunk !== component) continue;

    files.push({
      ...data.resolved!,
      content: transformFile(file, ctx),
    });
  }

  if (component.dependencies) {
    Object.assign(ctx.dependencies, component.dependencies);
  }
  if (component.devDependencies) {
    Object.assign(ctx.devDependencies, component.devDependencies);
  }

  const subComponents = Array.from(ctx.subComponents.values());
  for (const referee of chunkGraph.referees(component)) {
    if (isChunk(referee)) {
      subComponents.push(referee.chunkId);
    } else {
      subComponents.push(referee.name);
    }
  }

  return {
    name: component.name,
    title: component.title,
    description: component.description,
    files,
    subComponents,
    dependencies: ctx.dependencies,
    devDependencies: ctx.devDependencies,
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
  const { fileGraph, resolver, subComponents } = ctx;

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

    const name = isChunk(resolved.component) ? resolved.component.chunkId : resolved.component.name;
    const ref: z.input<typeof subComponentReference> = resolved.subRegistry
      ? {
          type: "sub-registry",
          subRegistry: resolved.subRegistry,
          component: name,
        }
      : name;

    subComponents.set(hashSubComponentReference(ref), ref);
    return encodeImport({ type: "local", fileId: getComponentFileId(resolved.file) });
  }

  const dep = resolver.getDepInfo(reference.dep);
  if (dep) {
    const map = dep.type === "dev" ? ctx.devDependencies : ctx.dependencies;
    map[dep.name] = dep.version;
  }

  return reference.specifier;
}

function transformFile(filePath: string, ctx: CompileComponentContext): string {
  const { fileGraph, onResolveFile } = ctx;
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
              component: data.chunk,
              file: data.resolved,
            },
          };
      }

      const resolved = onResolveFile ? onResolveFile(meta, { filePath }) : meta;

      return writeReference(resolved, ctx);
    });
  }

  return s.toString();
}
