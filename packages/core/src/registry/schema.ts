import { z } from "zod";

export type CompiledFile = z.input<typeof fileSchema>;
export type CompiledComponent = z.input<typeof componentSchema>;
export type CompiledRegistryInfo = z.input<typeof registryInfoSchema>;
export type DownloadedRegistryInfo = z.output<typeof registryInfoSchema>;
export type File = z.output<typeof fileSchema>;
export type Component = z.output<typeof componentSchema>;

export const indexSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});

export const routeFileSchema = z.object({
  type: z.literal("route-handler"),
  route: z.string(),
  content: z.string(),
});

export const fileSchema = z
  .object({
    type: z.literal(["components", "lib", "css", "ui", "layout"]),
    path: z.string(),
    target: z.string().optional(),
    content: z.string(),
  })
  .or(routeFileSchema);

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

  /**
   * override variables for the current component & its sub components.
   */
  variables: z.record(z.string(), z.unknown()).optional(),
});

export const registryInfoSchema = z.object({
  /**
   * define metadata for variables, variables can be accessed in plugins.
   */
  variables: z
    .record(
      z.string(),
      z.object({
        description: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * override variables for all components.
   */
  env: z.record(z.string(), z.unknown()).optional(),
  indexes: z.array(indexSchema).default([]),
  unlistedIndexes: z.array(indexSchema).default([]),

  registries: z.array(z.string()).optional(),
});
