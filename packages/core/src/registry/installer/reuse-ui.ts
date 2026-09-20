import { existsSync } from "node:fs";
import path from "node:path";
import type { InstallerPlugin } from ".";

export interface ReuseUIOptions {
  /**
   * file path in registry -> the consumer's file to use instead, relative to the base directory.
   *
   * e.g. `{ "utils/cn.ts": "lib/utils" }`
   */
  files?: Record<string, string>;
}

/**
 * Reuse the UI components that consumer already has, like the ones of Shadcn UI.
 */
export function reuseUI({ files = {} }: ReuseUIOptions = {}): InstallerPlugin {
  return {
    name: "reuse-ui",
    resolveId(file) {
      if (file.path in files) {
        return { id: path.resolve(this.baseDir, files[file.path]), external: true };
      }

      if (file.info.type !== "ui") return;
      const existing = path.resolve(
        this.baseDir,
        file.info.target?.replace("<dir>", this.outDir.ui) ??
          path.join(this.outDir.ui, path.basename(file.path)),
      );
      if (existsSync(existing)) return { id: existing, external: true };
    },
  };
}
