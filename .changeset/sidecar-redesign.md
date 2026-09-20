---
"fuma-cli": minor
"@fuma-cli/interactive": minor
---

**Redesign around files and sidecars**

- Files are made installable by a `<name>.install.ts` sidecar, `Registry` no longer lists components and files.
- Imports of files exported by your package are rewritten to package imports, derived from `exports` in `package.json` and verified per name. This replaces `onParseReference`, `onUnknownFile` and `isExternal`.
- New sidecar options: `preserve` to prefer the package import unless installed, `alias` to dedupe files across packages.
- New sidecar option `treeshake`: the file is installed per declaration, and missing declarations are merged into the consumer's file (`merge` status). Dependencies of such files are recorded per statement.
- The registry output is a manifest (`_registry.json`) and raw files, installing no longer needs a parser unless it merges.
- Assets referenced as `new URL("./file", import.meta.url)` are installed and linked.
- Installer: `plan()` & `apply()`, `registryAliases`, Rollup-style plugins with `resolveId`, `transform` and `writeBundle`. Route handlers are a built-in plugin.
