import { z } from "zod";

export type Manifest = z.output<typeof manifestSchema>;
export type ManifestFile = z.output<typeof fileSchema>;
export type ManifestImport = z.output<typeof importSchema>;
export type ManifestComponent = z.output<typeof componentSchema>;

const dependencies = z.record(z.string(), z.string().or(z.null()));

export const importSchema = z.object({
  /** span of the import specifier in file content (quotes excluded) */
  start: z.number(),
  end: z.number(),
  /** id of the imported file */
  id: z.string(),
  /** names taken from the file, the whole file if omitted */
  bindings: z.array(z.string()).optional(),
  /** when defined, the installer keeps this package import unless the imported file is installed */
  package: z.string().optional(),
});

const baseFileSchema = z.object({
  dependencies: dependencies.optional(),
  devDependencies: dependencies.optional(),
  imports: z.array(importSchema).optional(),
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

/** `<registry>:<path>` */
export function encodeFileId(registry: string, path: string): string {
  return `${registry}:${path}`;
}

export function decodeFileId(id: string): { registry: string; path: string } {
  const idx = id.indexOf(":");
  return { registry: id.slice(0, idx), path: id.slice(idx + 1) };
}
