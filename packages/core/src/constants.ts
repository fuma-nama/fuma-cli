export const typescriptExtensions = [".ts", ".tsx", ".js", ".jsx"];
export const SUPPORTED_LANGS = ["js", "jsx", "ts", "tsx", "dts"] as const;
export const SUPPORTED_FRAMEWORKS = [
  "next",
  "waku",
  "react-router",
  "tanstack-start",
  "none",
] as const;
export const MACRO_PATH = "fuma-cli/macros";

export type Framework = (typeof SUPPORTED_FRAMEWORKS)[number];
