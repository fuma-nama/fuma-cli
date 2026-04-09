import fs from "node:fs/promises";
import path from "node:path";
import type { Framework } from "@/constants";
import type { PackageJson } from "@/types";
import { detect, type DetectOptions } from "package-manager-detector";

function detectFrameworkFromPackageJson(pkg: PackageJson): Framework {
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  if (deps["next"]) return "next";
  if (deps["waku"]) return "waku";
  if (deps["react-router"] || deps["react-router-dom"]) return "react-router";
  if (deps["@tanstack/react-start"]) return "tanstack-start";
  return "none";
}

async function detectFrameworkFromConfigFiles(dir: string): Promise<Framework> {
  const files = await fs.readdir(dir).catch(() => []);

  for (const file of files) {
    if (file.startsWith("next.config.")) return "next";
    if (file.startsWith("waku.config.")) return "waku";
    if (file.startsWith("react-router.config.")) return "react-router";
  }

  return "none";
}

/**
 * Detects the preferred framework/tech stack.
 */
export async function detectFramework(cwd = process.cwd()): Promise<Framework> {
  const packageJson = await findNearestPackageJson(cwd);
  if (packageJson === null) return "none";

  const projectDir = path.dirname(packageJson.file);
  const result = await detectFrameworkFromConfigFiles(projectDir);
  if (result !== "none") return result;

  try {
    return detectFrameworkFromPackageJson(JSON.parse(packageJson.content) as PackageJson);
  } catch {
    return "none";
  }
}

async function findNearestPackageJson(startDir: string): Promise<{
  file: string;
  content: string;
} | null> {
  let dir = path.resolve(startDir);

  while (true) {
    const filePath = path.join(dir, "package.json");
    const content = await fs.readFile(filePath, "utf-8").catch(() => null);
    if (content !== null) {
      return {
        file: filePath,
        content,
      };
    }

    const parentDir = path.dirname(dir);
    if (dir === parentDir) {
      break; // reached filesystem root
    }
    dir = parentDir;
  }
  return null;
}

/** `package-manager-detector` wrapper */
export function detectPackageManager(options?: DetectOptions) {
  return detect(options);
}
