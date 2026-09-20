import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import type { FileRule } from "./registry";

export interface CompiledRule {
  isMatch: picomatch.Matcher;
  /** where the path after the fixed part of pattern starts, `undefined` for a path */
  rest?: number;
  rule: FileRule;
}

export function compileRule(pattern: string, rule: FileRule): CompiledRule {
  return { isMatch: picomatch(pattern), rest: getRestStart(pattern), rule };
}

/**
 * @param file - relative to the directory of registry
 * @returns the first matched rule, with `*` of its `target` & `alias` replaced
 */
export function matchRule(rules: CompiledRule[], file: string): FileRule | undefined {
  for (const { isMatch, rest, rule } of rules) {
    if (!isMatch(file)) continue;
    if (rest === undefined) return rule;

    const value = file.slice(rest);
    if ("alias" in rule) return { alias: rule.alias.replace(/\*+/, value) };
    if ("target" in rule && rule.target) {
      return { ...rule, target: rule.target.replace(/\*+/, value) };
    }
    return rule;
  }
}

/** @returns where the path after the fixed part of pattern starts, `undefined` for a path */
export function getRestStart(pattern: string) {
  const { base, isGlob } = picomatch.scan(pattern);
  if (isGlob) return base ? base.length + 1 : 0;
}

/**
 * Same matcher as rules, as the glob of Node.js has a different syntax.
 *
 * @param start - the result of `getRestStart()`, to skip directories before it
 * @returns matched files relative to `dir`, sorted
 */
export function glob(dir: string, pattern: string, start: number): string[] {
  const isMatch = picomatch(pattern);
  const out: string[] = [];

  /** @param prefix - of file paths, empty or ends with `/` */
  function walk(prefix: string) {
    for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
      const file = prefix + entry.name;
      if (!entry.isDirectory()) {
        if (isMatch(file)) out.push(file);
      } else if (entry.name !== "node_modules" && !entry.name.startsWith(".")) walk(`${file}/`);
    }
  }

  const prefix = pattern.slice(0, start);
  if (fs.existsSync(path.join(dir, prefix))) walk(prefix);
  return out.sort();
}
