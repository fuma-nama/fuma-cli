export const typescriptExtensions = [".ts", ".tsx", ".js", ".jsx"];
export const SUPPORTED_FRAMEWORKS = ["next", "waku", "react-router", "tanstack-start"] as const;
export const MACRO_PATH = "fuma-cli/macros";

export type Framework = (typeof SUPPORTED_FRAMEWORKS)[number];
