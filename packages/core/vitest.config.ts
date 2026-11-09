import ttsc from "@ttsc/unplugin/vite";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [ttsc()],
  resolve: {
    alias: {
      "@/": new URL("./src/", import.meta.url).pathname,
    },
  },
});
