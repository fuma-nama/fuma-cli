import path from "node:path";
import fs from "node:fs";

export function findNearestPackageJson(dir: string): string | undefined {
  while (true) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) return file;

    const parent = path.dirname(dir);
    if (dir === parent) return;
    dir = parent;
  }
}
