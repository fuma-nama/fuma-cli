import path from "node:path";
import fs from "node:fs/promises";
import type { CompiledComponent, CompiledFile, registryInfoSchema } from "@/registry/schema";
import type { z } from "zod";
import type { DistributiveOmit, PackageJson } from "@/types";
import { BidirectedGraph } from "@/utils/graph";
import { RawReference, resolveFiles, ScanResult } from "./resolve";
import { type Chunk, ChunkType, ComponentChunk, generateChunks } from "./chunks";
import { writechunks } from "./transform";
import type { DependenciesConfig } from "./deps";
import { findNearestPackageJson } from "@/utils/fs";

export interface FileGraphInfo {
  scanned?: ScanResult;
  resolved: ComponentFile;
  chunk?: Chunk;
}

export interface CompiledRegistry {
  name: string;
  components: CompiledComponent[];
  subRegistries?: CompiledRegistry[];
  info: z.output<typeof registryInfoSchema>;
}

export type ComponentFile = DistributiveOmit<CompiledFile, "content"> & {
  path: string;
  /** replace the actual content in file system */
  content?: string;
};

export interface Component extends DependenciesConfig {
  name: string;
  title?: string;
  description?: string;
  files: ComponentFile[];

  /**
   * Don't list the component in registry index file
   */
  unlisted?: boolean;
  /** custom data */
  meta?: unknown;
}

export interface Registry
  extends
    Omit<z.input<typeof registryInfoSchema>, "indexes" | "unlistedIndexes">,
    DependenciesConfig {
  /** unique name for registry (at least unique in the entire repository/monorepo) */
  name: string;
  packageJson?: string;
  tsconfigPath?: string;
  components: Component[];
  subRegistries?: Registry[];

  /**
   * The directory of registry, used to resolve relative paths & config files
   */
  dir: string;
}

export type Reference =
  | RawReference
  | {
      type: "sub-component";
      resolved:
        | {
            type: "local";
            subRegistry?: string;
            component: string;
            file: ComponentFile;
          }
        | {
            type: "http";
            registryUrl: string;
            subRegistry?: string;
            component: string;
            /** referenced file id, e.g. the target path of component, or the route of a route handler file */
            file: string;
          };
    };

export interface CompileOptions {
  root: Registry;
  onParseReference?: (reference: RawReference, from: { filePath: string }) => Reference;
  /**
   * When a referenced file is not found in component files, this function is called.
   * @returns file, or `false` to mark as external.
   */
  onUnknownFile?: (absolutePath: string) => ComponentFile | false | undefined;
  /**
   * if a reference is marked as external, compiler won't process & transform the import, and the file won't be included into the bundle.
   */
  isExternal?: (ref: RawReference) => boolean;
}

export interface CompileContext extends CompileOptions {
  fileGraph: BidirectedGraph<string, FileGraphInfo>;
  registryMap: Map<string, { registry: Registry; output: CompiledRegistry }>;
  packageJsons: PackageJsonMap;
}

export type TransformContext = CompileContext;

export async function compile(options: CompileOptions): Promise<CompiledRegistry> {
  const { root } = options;
  const registryMap = new Map<string, { registry: Registry; output: CompiledRegistry }>();

  const ctx: CompileContext = {
    ...options,
    fileGraph: new BidirectedGraph(),
    packageJsons: await generatePackageJsonMap(root),
    registryMap,
  };

  function initRegistry(registry: Registry) {
    const cached = registryMap.get(registry.name);
    if (cached) {
      if (cached.registry !== registry)
        throw new Error(
          `registry name must be unique, but there is multiple registries with the same name "${registry.name}"`,
        );
      return cached.output;
    }

    const output: CompiledRegistry = {
      name: registry.name,
      info: {
        indexes: [],
        unlistedIndexes: [],
        meta: registry.meta,
        registries: registry.subRegistries?.map((r) => r.name),
      },
      subRegistries: registry.subRegistries?.map(initRegistry),
      components: [],
    };
    registryMap.set(registry.name, { registry, output });

    for (const comp of registry.components) {
      const chunk: ComponentChunk = { type: ChunkType.Component, registry, component: comp };

      for (const file of comp.files) {
        const filePath = path.resolve(registry.dir, file.path);
        const { data } = ctx.fileGraph.addVertex(filePath, { resolved: file });

        if (data.chunk && data.chunk !== chunk) {
          throw new Error(
            `The same file "${filePath}" must not co-exist in multiple components, detected: ${comp.name} & ${(data.chunk as ComponentChunk).component.name}`,
          );
        }

        data.chunk = chunk;
      }
    }

    return output;
  }

  initRegistry(root);
  await resolveFiles(ctx);
  generateChunks(ctx);
  writechunks(ctx);

  return registryMap.get(root.name)!.output;
}

// absolute path -> info
export type PackageJsonMap = Map<string, { data: PackageJson | null; registry: Registry }>;

async function generatePackageJsonMap(root: Registry): Promise<PackageJsonMap> {
  const packageJsons: PackageJsonMap = new Map();
  const scanned = new Set<string>();

  async function findRegistryPackageJsons(registry: Registry) {
    if (scanned.has(registry.name)) return;
    scanned.add(registry.name);
    let packageJson: { file: string; content: string } | null;

    if (registry.packageJson) {
      const filePath = path.resolve(registry.dir, registry.packageJson);
      packageJson = {
        file: filePath,
        content: await fs.readFile(filePath, "utf-8"),
      };
    } else {
      packageJson = await findNearestPackageJson(registry.dir);
    }

    if (!packageJson)
      throw new Error(`failed to find the package.json file of registry "${registry.name}"`);

    packageJsons.set(packageJson.file, {
      data: JSON.parse(packageJson.content),
      registry,
    });

    if (registry.subRegistries)
      await Promise.all(registry.subRegistries.map(findRegistryPackageJsons));
  }

  await findRegistryPackageJsons(root);
  return packageJsons;
}
