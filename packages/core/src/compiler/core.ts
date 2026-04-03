import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  CompiledComponent,
  CompiledFile,
  registryInfoSchema,
  subComponentReference,
} from "@/registry/schema";
import type { z } from "zod";
import { parse } from "oxc-parser";
import { ResolverFactory } from "oxc-resolver";
import MagicString from "magic-string";
import { transformSpecifiers } from "@/utils/ast";
import type { DistributiveOmit, PackageJson } from "@/types";
import { encodeImport, getComponentFileId } from "@/registry/protocols/import";
import { MACRO_PATH } from "@/constants";
import { BidirectedGraph } from "@/utils/graph";

export type OnResolve = (
  reference: SourceReference,
  from: { component: Component; file: ComponentFile },
) => Reference;

export interface CompiledRegistry {
  name: string;
  components: CompiledComponent[];
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

  /**
   * Decide how to resolve a file
   */
  onResolveFile?: OnResolve;
  /**
   * When a referenced file is not found in component files, this function is called.
   * @returns file, or `false` to mark as external.
   */
  onUnknownFile?: (absolutePath: string) => ComponentFile | false | undefined;

  dependencies?: Record<string, string | null>;
  devDependencies?: Record<string, string | null>;
}

export interface CompileOptions {
  registry: Registry;
}

export interface CompileContext {
  registry: Registry;
  packageJson: PackageJson;
  resolver: RegistryResolver;
}

export async function compile(options: CompileOptions): Promise<CompiledRegistry> {
  const { registry } = options;
  const packageJson = (await readPackageJson(registry)) ?? {};
  const resolver = new RegistryResolver(packageJson, registry);
  const ctx: CompileContext = {
    packageJson,
    registry,
    resolver,
  };

  const output: CompiledRegistry = {
    name: registry.name,
    info: {
      indexes: [],
      unlistedIndexes: [],
      env: registry.env,
      variables: registry.variables,
    },
    components: [],
  };

  const builtComps = await Promise.all(
    registry.components.map(async (component) => {
      return [component, await compileComponent(component, ctx)] as [Component, CompiledComponent];
    }),
  );

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

interface FileInfo {
  resolved: ComponentFile | null;
}

class RegistryResolver {
  readonly fileGraph = new BidirectedGraph<string, FileInfo>();
  private readonly deps: Record<string, string | null>;
  private readonly devDeps: Record<string, string | null>;
  // resolve anything possible
  readonly oxc = new ResolverFactory({
    extensions: [".js", ".jsx", ".ts", ".tsx", ".node"],
    conditionNames: ["node", "import", "require", "default", "types"],
  });

  constructor(packageJson: PackageJson, registry: Registry) {
    for (const comp of registry.components) {
      for (const file of comp.files) {
        this.fileGraph.addVertex(path.resolve(registry.dir, file.path), {
          resolved: file,
        });
      }
    }

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
    }
  | {
      type: "unknown";
      specifier: string;
    };

export type Reference =
  | SourceReference
  | {
      type: "external";
      specifier: string;
    };

interface CompileComponentContext extends CompileContext {
  component: Component;
  dependencies: Record<string, string | null>;
  devDependencies: Record<string, string | null>;
  subComponents: Map<string, z.input<typeof subComponentReference>>;

  _processedFiles: Set<string>;
}

async function compileComponent(
  component: Component,
  compileContext: CompileContext,
): Promise<CompiledComponent> {
  const ctx: CompileComponentContext = {
    ...compileContext,
    component,
    dependencies: {},
    devDependencies: {},
    subComponents: new Map(),
    _processedFiles: new Set(),
  };
  const files = await Promise.all(component.files.map((file) => compileComponentFile(file, ctx)));

  if (component.dependencies) {
    Object.assign(ctx.dependencies, component.dependencies);
  }
  if (component.devDependencies) {
    Object.assign(ctx.devDependencies, component.devDependencies);
  }

  return {
    name: component.name,
    title: component.title,
    description: component.description,
    files,
    subComponents: Array.from(ctx.subComponents.values()),
    dependencies: ctx.dependencies,
    devDependencies: ctx.devDependencies,
  };
}

function hashSubComponentReference(ref: z.input<typeof subComponentReference>): string {
  if (typeof ref === "string") return ref;
  if (ref.type === "sub-registry") {
    return `sub-registry:${ref.subRegistry}:${ref.name}`;
  }
  return `http:${ref.registryUrl}:${ref.subRegistry ?? ""}:${ref.component}`;
}

async function compileComponentFile(
  file: ComponentFile,
  ctx: CompileComponentContext,
): Promise<CompiledFile> {
  const { _processedFiles, component, resolver, registry } = ctx;
  if (_processedFiles.has(file.path)) return [];
  _processedFiles.add(file.path);

  const queue: ComponentFile[] = [];

  function writeReference(reference: Reference) {
    // TODO: standardize "external" option
    const external = reference.type === "dependency" && reference.specifier.startsWith(MACRO_PATH);

    if (external) {
      return reference.specifier;
    }

    if (reference.type === "external") {
      return reference.specifier;
    }

    if (reference.type === "unknown") {
      if (!reference.specifier.startsWith("node:")) {
        console.warn(`Unknown specifier ${reference.specifier}, skipping for now`);
      }

      return reference.specifier;
    }

    if (reference.type === "file") {
      const refFile = registry.onUnknownFile?.(reference.file);
      if (refFile) {
        queue.push(refFile);
        return encodeImport({ type: "local", fileId: getComponentFileId(refFile) });
      }

      if (refFile === false) return;

      throw new Error(`Unknown file ${reference.file} referenced by ${file.path}`);
    }

    if (reference.type === "sub-component") {
      const resolved = reference.resolved;

      if (resolved.type === "local" && resolved.component === ctx.component) {
        return encodeImport({ type: "local", fileId: getComponentFileId(resolved.file) });
      }

      if (resolved.type === "http") {
        const ref: z.input<typeof subComponentReference> = {
          type: "http",
          registryUrl: resolved.registryUrl,
          subRegistry: resolved.registryUrl,
          component: resolved.component,
        };

        ctx.subComponents.set(hashSubComponentReference(ref), ref);
        return encodeImport({
          type: "local",
          fileId: resolved.file,
        });
      }

      const ref: z.input<typeof subComponentReference> = resolved.subRegistry
        ? {
            type: "sub-registry",
            subRegistry: resolved.subRegistry,
            name: resolved.component.name,
          }
        : resolved.component.name;

      ctx.subComponents.set(hashSubComponentReference(ref), ref);
      return encodeImport({ type: "local", fileId: getComponentFileId(resolved.file) });
    }

    const dep = resolver.getDepInfo(reference.dep);
    if (dep) {
      const map = dep.type === "dev" ? ctx.devDependencies : ctx.dependencies;
      map[dep.name] = dep.version;
    }

    return reference.specifier;
  }
  async function transformFile(): Promise<string> {
    const sourceFilePath = path.join(registry.dir, file.path);
    const astTypes: Record<string, "js" | "ts" | undefined> = {
      ".ts": "ts",
      ".tsx": "ts",
      ".js": "js",
      ".jsx": "js",
    };
    const astType = astTypes[path.extname(file.path)];
    const content = (await fs.readFile(sourceFilePath)).toString();

    if (!astType) {
      return content;
    }

    const ast = await parse(sourceFilePath, content, {
      astType,
    });

    if (ast.errors.length > 0) {
      throw new Error(`failed to parse file ${sourceFilePath}: \n${ast.errors.join("\n")}`);
    }

    const s = new MagicString(content);
    const ctx = { component, file };
    // Process import paths
    transformSpecifiers(ast.program, s, (specifier) => {
      let resolved: Reference | undefined;

      const onResolve = registry.onResolveFile;
      const resolvedSpecifier = resolver.oxc.resolveFileSync(sourceFilePath, specifier);

      if (resolvedSpecifier.error || !resolvedSpecifier.path) {
        resolved = {
          type: "unknown",
          specifier,
        };
      } else if (path.relative(registry.dir, resolvedSpecifier.path).startsWith(`..${path.sep}`)) {
        // outside of registry dir
        resolved = {
          type: "dependency",
          dep: getDepFromSpecifier(specifier)!,
          specifier,
        };
      } else {
        const referrers = resolver.fileGraph.referrers(path.resolve(resolvedSpecifier.path));
        const sub = referrers.next().value;

        if (sub) {
          resolved = {
            type: "sub-component",
            resolved: {
              type: "local",
              component: sub.component,
              file: sub.file,
            },
          };
        } else {
          resolved = {
            type: "file",
            file: resolvedSpecifier.path,
          };
        }
      }

      return writeReference(onResolve ? onResolve(resolved, ctx) : resolved);
    });

    return s.toString();
  }

  return {
    ...file,
    content: await transformFile(),
  };
}

function getDepFromSpecifier(specifier: string) {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}
