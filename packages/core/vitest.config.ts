import typia from "@typia/unplugin/vite";
import { defineProject } from "vitest/config";

export default defineProject({
  // resolved from the working directory by default, which is the repository root for `pnpm test`
  plugins: [typia({ tsconfig: new URL("./tsconfig.json", import.meta.url).pathname })],
  resolve: {
    alias: {
      "@/": new URL("./src/", import.meta.url).pathname,
    },
  },
});
