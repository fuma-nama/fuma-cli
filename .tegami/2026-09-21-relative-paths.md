---
packages:
  npm:@fuma-cli/interactive: patch
---

## Show relative paths

The override prompt and the progress of `InteractiveInstaller` show file paths relative to `cwd`, instead of absolute paths.
