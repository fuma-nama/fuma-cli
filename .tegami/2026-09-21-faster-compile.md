---
packages:
  npm:fuma-cli: patch
---

## Faster compilation

Each file is resolved to its registry and rule once, compiling the registry of Fumadocs takes 9% less time. The output is unchanged.

## `file.output` in `resolveId`

The `resolveId` hook of installer plugins receives the default location of file as `file.output`.

## Link imports of `.mts` & `.mjs` files

The installer left the imports of installed `.mts` & `.mjs` files unlinked, they are now treated like other scripts.
