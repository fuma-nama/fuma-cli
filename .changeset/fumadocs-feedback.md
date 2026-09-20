---
"fuma-cli": minor
---

Feedback from migrating Fumadocs

- Replace sidecars with `components` entries and `files` rules in `Registry`. `defineInstall`, `*.install.ts` and inherited files are removed.
- Fail the compilation when an imported package is not a dependency, it was a warning. This catches path aliases of files excluded by `tsconfig.json`.
- Skip Node.js built-ins imported without `node:`.
