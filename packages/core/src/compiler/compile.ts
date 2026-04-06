import * as path from "node:path";
import type { CompiledComponent, CompiledFile, registryInfoSchema } from "@/registry/schema";
import type { z } from "zod";
import type { DistributiveOmit } from "@/types";
import { BidirectedGraph } from "@/utils/graph";
import { PackageJsonMap, RawReference, resolveFiles, ScanResult } from "./resolve";
import { type Chunk, ChunkType, ComponentChunk, generateChunks } from "./chunks";
import { transformChunks } from "./transform";
import type { DependenciesConfig } from "./deps";

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
}

export interface Registry
  extends
    Omit<z.input<typeof registryInfoSchema>, "indexes" | "unlistedIndexes">,
    DependenciesConfig {
  /** unique name for registry (at least unique in the entire repository/monorepo) */
  name: string;
  packageJson: string;
  tsconfigPath: string;
  components: Component[];
  subRegistries?: Registry[];

  /**
   * The directory of registry, used to resolve relative paths
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
}

export interface TransformContext extends CompileContext {
  chunkGraph: BidirectedGraph<Chunk, undefined>;
  packageJsons: PackageJsonMap;
}

export async function compile(options: CompileOptions): Promise<CompiledRegistry> {
  const { root } = options;
  const registryMap = new Map<string, { registry: Registry; output: CompiledRegistry }>();

  const ctx: CompileContext = {
    ...options,
    fileGraph: new BidirectedGraph(),
    registryMap,
  };

  const filePaths: string[] = [];

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
        env: registry.env,
        variables: registry.variables,
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
        filePaths.push(filePath);
      }
    }

    return output;
  }

  initRegistry(root);
  const { packageJsons } = await resolveFiles(filePaths, ctx);

  transformChunks({
    ...ctx,
    packageJsons,
    chunkGraph: generateChunks(filePaths, ctx),
  });

  return registryMap.get(root.name)!.output;
}
