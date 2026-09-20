import typia from "@typia/unplugin/vite";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [typia()],
  resolve: {
    alias: {
      "@/": new URL("./src/", import.meta.url).pathname,
    },
  },
});
