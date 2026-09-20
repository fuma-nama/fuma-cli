import typia from "typia";

type Dependencies = Record<string, string | null>;

export interface ManifestImport {
  /** start of the import specifier in file content (quotes excluded), which is `package ?? id` */
  start: number;
  /** id of the imported file */
  id: string;
  /** names taken from a tree-shaken file, the whole file if omitted */
  bindings?: string[];
  /** when defined, the installer keeps this package import unless the imported file is installed */
  package?: string;
}

/** a top-level statement, statements partition the file content */
export interface StmtInfo {
  /** it starts from the end of last statement */
  end: number;
  /** top-level names, export names included */
  declares?: string[];
  /** indices of statements it needs */
  references?: number[];
  import?: boolean;
  dependencies?: Dependencies;
  devDependencies?: Dependencies;
}

interface BaseFile {
  dependencies?: Dependencies;
  devDependencies?: Dependencies;
  imports?: ManifestImport[];
  /** defined for tree-shaken files, which are installed per statement and carry dependencies on statements */
  stmtInfos?: StmtInfo[];
}

export type ManifestFile =
  | (BaseFile & {
      type: "components" | "lib" | "css" | "ui" | "layout";
      target?: string;
    })
  | (BaseFile & {
      type: "route-handler";
      route: string;
    });

export interface ManifestComponent {
  name: string;
  title?: string;
  description?: string;
  /** hidden from component lists, but still installable */
  unlisted?: boolean;
  /** paths of files in this registry */
  files: string[];
}

export interface Manifest {
  name: string;
  components: ManifestComponent[];
  /** file path (relative to registry dir) -> file */
  files: Record<string, ManifestFile>;
  /** names of sub registries */
  registries?: string[];
}

/** @throws when the input is not a manifest */
export const assertManifest: (input: unknown) => Manifest = typia.createAssert<Manifest>();

export { decodeFileId, encodeFileId } from "./id";
