import fs from "node:fs/promises";
import path from "node:path";
import type { CompiledRegistry } from "./compile";

export interface WriteOptions {
  dir: string;
  /**
   * Remove previous outputs
   *
   * @defaultValue false
   */
  cleanDir?: boolean;
}

/**
 * Write the manifest as `_registry.json` and file contents under `files`, sub registries are written to `<dir>/<name>`.
 */
export async function writeRegistry(out: CompiledRegistry, options: WriteOptions): Promise<void> {
  const { dir, cleanDir = false } = options;
  if (cleanDir) await fs.rm(dir, { recursive: true, force: true });

  const writes = [write(path.join(dir, "_registry.json"), JSON.stringify(out.manifest))];
  for (const [file, content] of out.files) {
    writes.push(write(path.join(dir, "files", file), content));
  }
  for (const child of out.subRegistries) {
    writes.push(writeRegistry(child, { dir: path.join(dir, child.manifest.name) }));
  }

  await Promise.all(writes);
}

async function write(file: string, content: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
