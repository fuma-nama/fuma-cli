export interface DependenciesConfig {
  dependencies?: Record<string, string | null>;
  devDependencies?: Record<string, string | null>;
}

export interface DepInfo {
  type: "runtime" | "dev";
  name: string;
  version: string | null;
}

export function resolveDepInfo(name: string, v: DependenciesConfig): DepInfo | undefined {
  if (v.dependencies && name in v.dependencies)
    return {
      name,
      type: "runtime",
      version: v.dependencies[name],
    };

  if (v.devDependencies && name in v.devDependencies)
    return {
      name,
      type: "dev",
      version: v.devDependencies[name],
    };
}
