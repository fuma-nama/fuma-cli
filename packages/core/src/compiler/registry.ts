import type { ManifestFile } from "@/registry/schema";
import type { DistributiveOmit } from "@/types";

export interface ComponentInfo {
  name: string;
  title?: string;
  description?: string;
  /** hidden from component lists, but still installable */
  unlisted?: boolean;
}

export type InstallInfo =
  | (DistributiveOmit<
      ManifestFile,
      "imports" | "stmtInfos" | "dependencies" | "devDependencies"
    > & {
      /**
       * The component this file belongs to, pass an object on one of its files to describe the component.
       *
       * Without a component, the file is only installed when imported by another file.
       */
      component?: string | ComponentInfo;
      /**
       * Keep imports of this file as package imports, unless the consumer has installed it.
       *
       * The file must be reachable from an export of its package.
       */
      preserve?: boolean;
      /**
       * Install the file per declaration: only the bindings imported by installed files, merged into the file if the consumer already has it.
       */
      treeshake?: boolean;
    })
  | {
      /** resolve imports of this file to another installable file, as an import specifier relative to the sidecar */
      alias: string;
    };

export interface Registry {
  /** unique name of registry */
  name: string;
  /** the directory to scan for sidecars, file paths are relative to it */
  dir: string;
  /**
   * source files of package exports, e.g. `{ "./button": "button.tsx" }`.
   *
   * By default, derived from `exports` in `package.json` by mapping `dist` to `dir`.
   */
  entries?: Record<string, string>;
  /** install info of files without a sidecar, e.g. generated from a glob */
  files?: Record<string, InstallInfo>;
  /** paths (relative to `dir`) the consumer is expected to own, imports of them are kept as-is */
  external?: string[];
  /** override the version of dependencies, `null` for the latest */
  dependencies?: Record<string, string | null>;
  subRegistries?: Registry[];
}

export function defineInstall(info: InstallInfo): InstallInfo {
  return info;
}
