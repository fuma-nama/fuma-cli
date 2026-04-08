import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "./src/detect.ts",
    "./src/{index,config}.ts",
    "./src/registry/{connector,schema}.ts",
    "./src/registry/installer/index.ts",
    "./src/macros/route-handler.ts",
    "./src/compiler/index.ts",
  ],
  format: "esm",
  dts: true,
  fixedExtension: false,
  target: "node22",
  deps: {
    onlyBundle: [],
  },
  exports: {
    enabled: true,
  },
});
