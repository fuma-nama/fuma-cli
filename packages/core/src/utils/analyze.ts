import { analyze, type Module } from "yuku-analyzer";

/** the only place that touches the parser */
export function analyzeFile(file: string, code: string): Module {
  const module = analyze(code, { path: file });
  const errors = module.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) {
    throw new Error(`failed to parse ${file}:\n${errors.map((e) => e.message).join("\n")}`);
  }
  return module;
}
