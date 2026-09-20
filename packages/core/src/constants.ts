/** scripts that can import other files, in the order to resolve */
export const SCRIPT_EXTS = [".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs"];
export const SUPPORTED_FRAMEWORKS = [
  "next",
  "waku",
  "react-router",
  "tanstack-start",
  "none",
] as const;
export const MACRO_PATH = "fuma-cli/macros";

export type Framework = (typeof SUPPORTED_FRAMEWORKS)[number];
