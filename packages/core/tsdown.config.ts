import typia from "@typia/unplugin/rolldown";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "./src/detect.ts",
    "./src/registry/{connector,schema}.ts",
    "./src/registry/installer/index.ts",
    "./src/macros/route-handler.ts",
    "./src/compiler/index.ts",
  ],
  plugins: [typia()],
  format: "esm",
  dts: true,
  fixedExtension: false,
  target: "es2023",
  deps: {
    onlyBundle: ["package-manager-detector", "typia"],
  },
  exports: {
    enabled: true,
  },
});
