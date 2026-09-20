import fs from "node:fs/promises";
import { x } from "tinyexec";
import path from "node:path";
import { detect, type AgentName } from "package-manager-detector";
import type { PackageJson } from "@/types";

export async function createDeps(
  cwd: string,
  dependencies: Record<string, string | null>,
  devDependencies: Record<string, string | null>,
) {
  const packageJsonPath = path.join(cwd, "package.json");
  const packageJson = await fs
    .readFile(packageJsonPath, "utf-8")
    .then((res) => JSON.parse(res) as PackageJson)
    .catch(() => null);

  return new DependencyManager(cwd, packageJson, dependencies, devDependencies);
}

export class DependencyManager {
  /** missing packages as `name@version`, to pass to a package manager */
  readonly dependencies: string[] = [];
  readonly devDependencies: string[] = [];
  /** missing packages and their version, `null` for the latest */
  readonly required: Record<string, string | null> = {};
  readonly requiredDev: Record<string, string | null> = {};

  constructor(
    private readonly cwd: string,
    private readonly packageJson: PackageJson | null,
    dependencies: Record<string, string | null>,
    devDependencies: Record<string, string | null>,
  ) {
    const isInstalled = (name: string) =>
      packageJson?.dependencies?.[name] !== undefined ||
      packageJson?.devDependencies?.[name] !== undefined;

    for (const name in dependencies) {
      if (isInstalled(name)) continue;
      this.required[name] = dependencies[name];
      this.dependencies.push(encodeDep(name, dependencies[name]));
    }

    for (const name in devDependencies) {
      if (isInstalled(name)) continue;
      this.requiredDev[name] = devDependencies[name];
      this.devDependencies.push(encodeDep(name, devDependencies[name]));
    }
  }

  hasRequired() {
    return this.dependencies.length > 0 || this.devDependencies.length > 0;
  }

  async writeRequired(packageJsonPath = path.resolve(this.cwd, "package.json")) {
    if (this.packageJson === null) return false;

    for (const name in this.required) {
      this.packageJson.dependencies ??= {};
      this.packageJson.dependencies[name] ??= this.required[name] || "latest";
    }

    for (const name in this.requiredDev) {
      this.packageJson.devDependencies ??= {};
      this.packageJson.devDependencies[name] ??= this.requiredDev[name] || "latest";
    }

    await fs.writeFile(packageJsonPath, JSON.stringify(this.packageJson, null, 2));
  }

  async installRequired(packageManager?: AgentName) {
    packageManager ??= (await detect())?.name ?? "npm";

    if (this.dependencies.length > 0) await x(packageManager, ["install", ...this.dependencies]);
    if (this.devDependencies.length > 0)
      await x(packageManager, ["install", ...this.devDependencies, "-D"]);
  }
}

function encodeDep(name: string, version: string | null): string {
  return version ? `${name}@${version}` : name;
}
