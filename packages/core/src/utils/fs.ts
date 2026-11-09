import fs from "node:fs";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function findNearestPackageJson(dir: string): string | undefined {
  const file = findPackageJSON(pathToFileURL(dir + path.sep));
  // it gives back the input when nothing is found
  if (file && fs.existsSync(file) && path.basename(file) === "package.json") return file;
}

export function toPosix(file: string) {
  return path.sep === "/" ? file : file.replaceAll(path.sep, "/");
}
