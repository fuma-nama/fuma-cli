import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts"],
  format: "esm",
  dts: { sourcemap: false },
  fixedExtension: false,
  target: "node22",
  deps: {
    onlyBundle: [],
  },
  exports: {
    enabled: true,
  },
});
