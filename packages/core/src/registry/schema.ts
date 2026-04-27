import { z } from "zod";

export type CompiledFile = z.input<typeof fileSchema>;
export type CompiledComponent = z.input<typeof componentSchema>;
export type CompiledRegistryInfo = z.input<typeof registryInfoSchema>;
export type CompiledIndex = z.input<typeof indexSchema>;
export type DownloadedRegistryInfo = z.output<typeof registryInfoSchema>;
export type File = z.output<typeof fileSchema>;
export type Component = z.output<typeof componentSchema>;

export const indexSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});

const baseFileSchema = z.object({
  content: z.string(),
  /** custom data for file */
  meta: z.unknown().optional(),
});

export const fileSchema = z.union([
  baseFileSchema.extend({
    type: z.literal(["components", "lib", "css", "ui", "layout"]),
    path: z.string(),
    target: z.string().optional(),
  }),
  baseFileSchema.extend({
    type: z.literal("route-handler"),
    route: z.string(),
  }),
]);

export const subComponentReference = z.union([
  // name
  z.string(),
  // sub registry + name
  z.object({
    type: z.literal("sub-registry"),
    subRegistry: z.string(),
    component: z.string(),
  }),
  z.object({
    type: z.literal("http"),
    registryUrl: z.string(),
    subRegistry: z.string().optional(),
    component: z.string(),
  }),
]);

export const componentSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  files: z.array(fileSchema),
  dependencies: z.record(z.string(), z.string().or(z.null())),
  devDependencies: z.record(z.string(), z.string().or(z.null())),
  /**
   * list of sub components.
   */
  subComponents: z.array(subComponentReference).default([]),

  /** custom data for component */
  meta: z.unknown().optional(),
});

export const registryInfoSchema = z.object({
  indexes: z.array(indexSchema).default([]),
  unlistedIndexes: z.array(indexSchema).default([]),

  /** names for sub registries */
  registries: z.array(z.string()).optional(),
  /** custom data for registry */
  meta: z.unknown().optional(),
});
