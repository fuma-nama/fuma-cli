---
packages:
  "@fuma-cli/interactive": patch
---

### Drop picocolors

- Colors use Node.js `util.styleText`, so `@fuma-cli/interactive` no longer depends on `picocolors`.
