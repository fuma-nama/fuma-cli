## @fuma-cli/interactive@0.1.3

### Show relative paths

The override prompt and the progress of `InteractiveInstaller` show file paths relative to `cwd`, instead of absolute paths.

## @fuma-cli/interactive@0.1.2

### Rename to `InteractiveInstaller`

`FumadocsComponentInstaller` is kept as a deprecated alias. The constructor accepts `io` to override the prompts.

## 0.1.1

### Patch Changes

- Updated dependencies [7483b0a]
  - fuma-cli@0.3.0

## 0.1.0

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

### Patch Changes

- Updated dependencies [9e56ea4]
  - fuma-cli@0.2.0

## 0.0.6

### Patch Changes

- Updated dependencies [7317f03]
  - fuma-cli@0.1.1

## 0.0.5

### Patch Changes

- Updated dependencies [646a031]
  - fuma-cli@0.1.0

## 0.0.4

### Patch Changes

- Updated dependencies [d1932c8]
  - fuma-cli@0.0.6

## 0.0.3

### Patch Changes

- c5e902a: add `add()` to interactive Fuma CLI
- Updated dependencies [c5e902a]
  - fuma-cli@0.0.5

## 0.0.2

### Patch Changes

- Updated dependencies [c846a09]
- Updated dependencies [aa2c715]
  - fuma-cli@0.0.4
