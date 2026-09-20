## 0.3.0

### Minor Changes

- 7483b0a: Feedback from migrating Fumadocs

  - Replace sidecars with `components` entries and `files` rules in `Registry`. `defineInstall`, `*.install.ts` and inherited files are removed.
  - Fail the compilation when an imported package is not a dependency, it was a warning. This catches path aliases of files excluded by `tsconfig.json`.
  - Skip Node.js built-ins imported without `node:`.

## 0.2.0

### Minor Changes

- 9e56ea4: **Redesign around files and sidecars**

  - Files are made installable by a `<name>.install.ts` sidecar, `Registry` no longer lists components and files.
  - Imports of files exported by your package are rewritten to package imports, derived from `exports` in `package.json` and verified per name. This replaces `onParseReference`, `onUnknownFile` and `isExternal`.
  - New sidecar options: `preserve` to prefer the package import unless installed, `alias` to dedupe files across packages.
  - New sidecar option `treeshake`: the file is installed per declaration, and missing declarations are merged into the consumer's file (`merge` status). Dependencies of such files are recorded per statement.
  - The registry output is a manifest (`_registry.json`) and raw files, installing no longer needs a parser unless it merges.
  - Assets referenced as `new URL("./file", import.meta.url)` are installed and linked.
  - Installer: `plan()` & `apply()`, `registryAliases`, Rollup-style plugins with `resolveId`, `transform` and `writeBundle`. Route handlers are a built-in plugin.
  - `fuma-cli/registry/schema` exports types and `assertManifest()` instead of Zod schemas, `zod` is no longer a dependency.

## 0.1.1

### Patch Changes

- 7317f03: Fix empty chunks not generated

## 0.1.0

### Minor Changes

- 646a031: Support hooks for transformations during compilation

## 0.0.6

### Patch Changes

- d1932c8: Make tsconfig & package.json paths optional

## 0.0.5

### Patch Changes

- c5e902a: add `add()` to interactive Fuma CLI

## 0.0.4

### Patch Changes

- c846a09: detect default framework option from `cwd`
- aa2c715: Support `detect` util

## 0.0.3

### Patch Changes

- 6590069: simplify installer usage

## 0.0.2

### Patch Changes

- 66da436: improve performance

## 0.0.1

### Patch Changes

- b7d0e77: initial release
