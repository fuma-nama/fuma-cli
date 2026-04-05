import * as fs from "node:fs/promises";
import * as path from "node:path";
import picocolors from "picocolors";
import type { CompiledRegistry } from "@/compiler/compile";

export * from "./compile";

export async function writeRegistry(
  out: CompiledRegistry,
  options: {
    dir: string;

    /**
     * Remove previous outputs
     *
     * @defaultValue false
     */
    cleanDir?: boolean;

    log?: boolean;
  },
): Promise<void> {
  const { dir, cleanDir = false, log = true } = options;

  if (cleanDir) {
    await fs.rm(dir, {
      recursive: true,
      force: true,
    });
    console.log(picocolors.bold(picocolors.greenBright("Cleaned directory")));
  }

  async function writeInfo() {
    const file = path.join(dir, "_registry.json");
    const json = JSON.stringify(out.info, null, 2);

    await writeFile(file, json, log);
  }

  const write = out.components.map(async (comp) => {
    const file = path.join(dir, `${comp.name}.json`);
    const json = JSON.stringify(comp, null, 2);

    await writeFile(file, json, log);
  });

  write.push(writeInfo());
  for (const child of out.subRegistries) {
    write.push(
      writeRegistry(child, {
        dir: path.join(dir, child.name),
        log: options.log,
      }),
    );
  }

  await Promise.all(write);
}

async function writeFile(file: string, content: string, log = true): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);

  if (log) {
    const size = (Buffer.byteLength(content) / 1024).toFixed(2);

    console.log(
      `${picocolors.greenBright("+")} ${path.relative(process.cwd(), file)} ${picocolors.dim(`${size} KB`)}`,
    );
  }
}
