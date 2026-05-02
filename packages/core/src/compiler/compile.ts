import path from "node:path";
import fs from "node:fs/promises";
import type {
  CompiledComponent,
  CompiledFile,
  registryInfoSchema,
  subComponentReference,
} from "@/registry/schema";
import type { z } from "zod";
import type { DistributiveOmit, PackageJson } from "@/types";
import { BidirectedGraph } from "@/utils/graph";
import { RawReference, resolveChunks, resolveFiles, ScanResult } from "./resolve";
import { type Chunk, ChunkType, ComponentChunk, generateChunks } from "./chunks";
import { TransformFileContext, writeChunks } from "./transform";
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
  files?: ComponentFile[];
  subComponents?: z.input<typeof subComponentReference>[];

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

export type Reference = RawReference | SubComponentReference;

export interface SubComponentReference {
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
}

export interface CompileOptions {
  root: Registry;
  onParseReference?: (reference: RawReference, from: { filePath: string }) => Reference;
  /**
   * When a referenced file is not found in component files, this function is called.
   * @returns file, or `false` to mark as external.
   */
  onUnknownFile?: (absolutePath: string) => ComponentFile | false | undefined;

  beforeTransform?: (
    content: string,
    file: string,
    ctx: TransformFileContext,
  ) => string | undefined;
  afterTransform?: (content: string, file: string, ctx: TransformFileContext) => string | undefined;

  /**
   * if a reference is marked as external, compiler won't process & transform the import, and the file won't be included into the bundle.
   */
  isExternal?: (ref: RawReference) => boolean;
}

export interface CompileContext {
  options: CompileOptions;
  fileGraph: BidirectedGraph<string, FileGraphInfo>;
  chunks: Set<Chunk>;
  registryMap: Map<string, RegistryInfo>;

  /** absolute file path -> registry name */
  _registryPackageJsonPaths: Map<string, string>;
}

interface RegistryInfo {
  registry: Registry;
  output: CompiledRegistry;
  packageJsonPath: string;
  packageJson: PackageJson;
}

export async function compile(options: CompileOptions): Promise<CompiledRegistry> {
  const { root } = options;

  const ctx: CompileContext = {
    options,
    fileGraph: new BidirectedGraph(),
    registryMap: new Map(),
    chunks: new Set(),
    _registryPackageJsonPaths: new Map(),
  };

  async function initRegistry(registry: Registry): Promise<CompiledRegistry> {
    const cached = ctx.registryMap.get(registry.name);
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
      components: [],
    };
    const info: RegistryInfo = {
      registry,
      output,
      packageJsonPath: null as never,
      packageJson: null as never,
    };
    ctx.registryMap.set(registry.name, info);

    for (const comp of registry.components) {
      const chunk: ComponentChunk = { type: ChunkType.Component, registry, component: comp };
      ctx.chunks.add(chunk);
      if (!comp.files) continue;

      for (const file of comp.files) {
        const filePath = path.resolve(registry.dir, file.path);
        const { data } = ctx.fileGraph.addVertex(filePath, { resolved: file, chunk });

        if (data.chunk !== chunk) {
          throw new Error(
            `The same file "${filePath}" must not co-exist in multiple components, detected: ${comp.name} & ${(data.chunk as ComponentChunk).component.name}`,
          );
        }
      }
    }

    if (registry.packageJson) {
      const filePath = path.resolve(registry.dir, registry.packageJson);
      info.packageJsonPath = filePath;
      info.packageJson = JSON.parse(await fs.readFile(filePath, "utf-8"));
    } else {
      const resolved = await findNearestPackageJson(registry.dir);
      if (!resolved)
        throw new Error(`failed to find the package.json file of registry "${registry.name}"`);
      info.packageJsonPath = resolved.file;
      info.packageJson = JSON.parse(resolved.content);
    }

    ctx._registryPackageJsonPaths.set(info.packageJsonPath, registry.name);
    if (registry.subRegistries)
      output.subRegistries = await Promise.all(registry.subRegistries.map(initRegistry));

    return output;
  }

  const rootOutput = await initRegistry(root);
  await resolveFiles(ctx);
  generateChunks(ctx);
  resolveChunks(ctx);
  writeChunks(ctx);

  return rootOutput;
}
