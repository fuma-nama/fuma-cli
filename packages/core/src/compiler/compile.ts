import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CompiledComponent, CompiledFile, registryInfoSchema } from "@/registry/schema";
import type { z } from "zod";
import { ResolverFactory } from "oxc-resolver";
import type { Awaitable, DistributiveOmit, PackageJson } from "@/types";
import { BidirectedGraph } from "@/utils/graph";
import { RawReference, resolveFiles, ScanResult } from "./resolve";
import { type Chunk, generateChunks } from "./chunks";
import { transformComponent } from "./transform";

export interface FileGraphInfo {
  scanned?: ScanResult;
  resolved?: ComponentFile;
  chunks?: Set<Component | Chunk>;
}

export type OnResolve = (reference: SourceReference, from: { filePath: string }) => Reference;

export interface CompiledRegistry {
  name: string;
  components: CompiledComponent[];
  // TODO: implement
  subRegistries: CompiledRegistry[];
  info: z.output<typeof registryInfoSchema>;
}

export type ComponentFile = DistributiveOmit<CompiledFile, "content"> & {
  path: string;
};

export interface Component {
  name: string;
  title?: string;
  description?: string;
  files: ComponentFile[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;

  /**
   * Don't list the component in registry index file
   */
  unlisted?: boolean;
}

export interface Registry extends Omit<
  z.input<typeof registryInfoSchema>,
  "indexes" | "unlistedIndexes"
> {
  name: string;
  packageJson: string | PackageJson;
  tsconfigPath: string;
  components: Component[];

  /**
   * The directory of registry, used to resolve relative paths
   */
  dir: string;

  dependencies?: Record<string, string | null>;
  devDependencies?: Record<string, string | null>;
}

export interface CompileOptions {
  registry: Registry;
  /**
   * Decide how to resolve a file
   */
  onResolveFile?: OnResolve;
  /**
   * When a referenced file is not found in component files, this function is called.
   * @returns file, or `false` to mark as external.
   */
  onUnknownFile?: (absolutePath: string) => Awaitable<ComponentFile | false | undefined>;
  /**
   * if a reference is marked as external, compiler won't process & transform the import, and the file won't be included into the bundle.
   */
  isExternal?: (ref: RawReference) => boolean;
}

export interface CompileContext extends CompileOptions {
  packageJson: PackageJson;
  resolver: RegistryResolver;
  fileGraph: BidirectedGraph<string, FileGraphInfo>;
}

export interface TransformCompileContext extends CompileContext {
  chunkGraph: BidirectedGraph<Component | Chunk, undefined>;
}

export async function compile(options: CompileOptions): Promise<CompiledRegistry> {
  const { registry } = options;
  const packageJson = (await readPackageJson(registry)) ?? {};
  const resolver = new RegistryResolver(packageJson, registry);
  const ctx: CompileContext = {
    ...options,
    packageJson,
    resolver,
    fileGraph: new BidirectedGraph(),
  };

  const output: CompiledRegistry = {
    name: registry.name,
    info: {
      indexes: [],
      unlistedIndexes: [],
      env: registry.env,
      variables: registry.variables,
    },
    subRegistries: [],
    components: [],
  };

  // scan
  const filePaths: string[] = [];
  for (const comp of registry.components) {
    for (const file of comp.files) {
      const filePath = path.resolve(registry.dir, file.path);
      const { data } = ctx.fileGraph.addVertex(filePath, { resolved: file });
      data.chunks ??= new Set();
      data.chunks.add(comp);
      filePaths.push(filePath);
    }
  }

  await resolveFiles(filePaths, ctx);

  const transformCtx: TransformCompileContext = {
    ...ctx,
    chunkGraph: generateChunks(filePaths, ctx),
  };

  const builtComps = registry.components.map((component) => {
    return [component, transformComponent(component, transformCtx)] as [
      Component,
      CompiledComponent,
    ];
  });

  for (const [input, comp] of builtComps) {
    const arr = input.unlisted ? output.info.unlistedIndexes : output.info.indexes;

    arr.push({
      name: input.name,
      title: input.title,
      description: input.description,
    });
    output.components.push(comp);
  }

  return output;
}

async function readPackageJson(registry: Registry): Promise<PackageJson | undefined> {
  const packageJson = registry.packageJson;
  if (typeof packageJson !== "string") return packageJson;

  return fs
    .readFile(path.join(registry.dir, packageJson))
    .then((res) => JSON.parse(res.toString()) as PackageJson)
    .catch(() => undefined);
}

class RegistryResolver {
  private readonly deps: Record<string, string | null>;
  private readonly devDeps: Record<string, string | null>;
  // resolve anything possible
  readonly oxc = new ResolverFactory({
    extensions: [".js", ".jsx", ".ts", ".tsx", ".node"],
    conditionNames: ["node", "import", "require", "default", "types"],
  });

  constructor(packageJson: PackageJson, registry: Registry) {
    this.deps = {
      ...packageJson?.dependencies,
      ...registry.dependencies,
    };

    this.devDeps = {
      ...packageJson?.devDependencies,
      ...registry.devDependencies,
    };
  }

  getDepInfo(name: string):
    | {
        type: "runtime" | "dev";
        name: string;
        version: string | null;
      }
    | undefined {
    if (name in this.deps)
      return {
        name,
        type: "runtime",
        version: this.deps[name]!,
      };

    if (name in this.devDeps)
      return {
        name,
        type: "dev",
        version: this.devDeps[name]!,
      };

    console.warn(`dep info for ${name} cannot be found`);
  }
}

export type SourceReference =
  | RawReference
  | {
      type: "sub-component";
      resolved:
        | {
            type: "local";
            subRegistry?: string;
            component: Component;
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

export type Reference = SourceReference;
