import { z } from "zod";

export type Manifest = z.output<typeof manifestSchema>;
export type ManifestFile = z.output<typeof fileSchema>;
export type ManifestImport = z.output<typeof importSchema>;
export type StmtInfo = z.output<typeof stmtInfoSchema>;
export type ManifestComponent = z.output<typeof componentSchema>;

const dependencies = z.record(z.string(), z.string().or(z.null()));

export const importSchema = z.object({
  /** start of the import specifier in file content (quotes excluded), which is `package ?? id` */
  start: z.number(),
  /** id of the imported file */
  id: z.string(),
  /** names taken from a tree-shaken file, the whole file if omitted */
  bindings: z.array(z.string()).optional(),
  /** when defined, the installer keeps this package import unless the imported file is installed */
  package: z.string().optional(),
});

/** a top-level statement, statements partition the file content */
export const stmtInfoSchema = z.object({
  /** it starts from the end of last statement */
  end: z.number(),
  /** top-level names, export names included */
  declares: z.array(z.string()).optional(),
  /** indices of statements it needs */
  references: z.array(z.number()).optional(),
  import: z.boolean().optional(),
  dependencies: dependencies.optional(),
  devDependencies: dependencies.optional(),
});

const baseFileSchema = z.object({
  dependencies: dependencies.optional(),
  devDependencies: dependencies.optional(),
  imports: z.array(importSchema).optional(),
  /** defined for tree-shaken files, which are installed per statement and carry dependencies on statements */
  stmtInfos: z.array(stmtInfoSchema).optional(),
});

export const fileSchema = z.union([
  baseFileSchema.extend({
    type: z.literal(["components", "lib", "css", "ui", "layout"]),
    target: z.string().optional(),
  }),
  baseFileSchema.extend({
    type: z.literal("route-handler"),
    route: z.string(),
  }),
]);

export const componentSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  /** hidden from component lists, but still installable */
  unlisted: z.boolean().optional(),
  /** paths of files in this registry */
  files: z.array(z.string()),
});

export const manifestSchema = z.object({
  name: z.string(),
  components: z.array(componentSchema),
  /** file path (relative to registry dir) -> file */
  files: z.record(z.string(), fileSchema),
  /** names of sub registries */
  registries: z.array(z.string()).optional(),
});

export { decodeFileId, encodeFileId } from "./id";
