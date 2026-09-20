---
packages:
  npm:fuma-cli: patch
---

## Glob entries of components

`entry` of a component accepts glob patterns. With `*` in the name, each matched file becomes its own component:

```ts
const components: Registry["components"] = {
  icons: "icons/*.tsx",
  "icons/*": { unlisted: true, entry: "icons/*.tsx" },
};
```

Patterns of `files` are matched by [picomatch](https://github.com/micromatch/picomatch), compiled once per pattern.

## `reuseUI` plugin

A built-in installer plugin to use the UI components that consumer already has, exported from `fuma-cli/registry/installer`. Plugins can read `this.outDir`.

## Catch mistakes of `files`

- A pattern without globs fails the compilation when the file doesn't exist, like after a rename.
- Two files of the same name installed to the same location by a rule without `target` fail the compilation.

## `required` of `DependencyManager`

`deps.required` and `deps.requiredDev` are the missing packages with their versions, no need to decode `deps.dependencies`.
