---
packages:
  "fuma-cli": patch
---

### Parse with Babel

- The compiler and the installer parse code with Babel instead of Yuku, so `fuma-cli` needs no native binding.
- CLIs that bundle `fuma-cli` need no extra dependencies.
