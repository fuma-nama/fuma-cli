import path from "node:path";
import fs from "node:fs/promises";

export async function findNearestPackageJson(startDir: string): Promise<{
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
