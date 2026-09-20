import type { ManifestComponent, ManifestFile } from "@/registry/schema";
import type { DistributiveOmit } from "@/types";

export type Component = Omit<ManifestComponent, "name" | "files"> & {
  /** entry files, relative to `dir` */
  entry: string | string[];
};

export type FileRule =
  | (DistributiveOmit<
      ManifestFile,
      "imports" | "stmtInfos" | "dependencies" | "devDependencies"
    > & {
      /**
       * Keep imports of the file as package imports, unless the consumer has installed it.
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
      /** install another file instead, as an import specifier relative to `dir` */
      alias: string;
    };

export interface Registry {
  /** unique name of registry */
  name: string;
  /** the source directory, paths are relative to it */
  dir: string;
  /**
   * source files of package exports, e.g. `{ "./button": "button.tsx" }`.
   *
   * By default, derived from `exports` in `package.json` by mapping `dist` to `dir`.
   */
  entries?: Record<string, string>;
  /** name -> entry files, or the component with its info */
  components?: Record<string, string | string[] | Component>;
  /**
   * glob pattern -> how the matched files are installed, the first match wins.
   *
   * A file is only installed when it is an entry of component, or imported by an installed file.
   */
  files?: Record<string, FileRule>;
  /** paths (relative to `dir`) the consumer is expected to own, imports of them are kept as-is */
  external?: string[];
  /** override the version of dependencies, `null` for the latest */
  dependencies?: Record<string, string | null>;
  subRegistries?: Registry[];
}
