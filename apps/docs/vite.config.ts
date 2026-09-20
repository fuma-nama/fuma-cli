import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import press from "fumapress/vite";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { remarkSteps } from "fumadocs-core/mdx-plugins/remark-steps";

export default defineConfig({
  plugins: [
    press(),
    fumadocsMdx({
      globalOptions: {
        mdxOptions: {
          remarkPlugins: (v) => [...v, remarkSteps],
        },
      },
    }),
    tailwindcss(),
  ],
});
