---
name: "explore: Tauri desktop switch to npm path for sidecar"
about: Investigates whether taco-desktop can use @taco-ai/sidecar instead of dist/runtime/
title: "[desktop] Explore: switch from dist/runtime/ staging to npm @taco-ai/sidecar"
labels: "enhancement,desktop,sidecar"
---

## Context

Today, `taco-desktop` builds and stages the sidecar locally via `clients/taco-desktop/scripts/stageSidecar.mjs`, which copies `packages/sidecar/dist/runtime/<triple>/` into the desktop app bundle. This is a monorepo-internal path.

After the npm publish of `@taco-ai/sidecar`, the desktop could instead consume it as a normal npm dependency.

## What to evaluate

1. **Bundle size**: does `optionalDependencies` + `@taco-ai/sidecar` pull in more or less than the current staged `dist/runtime/`?
2. **Update cadence**: does pinning `@taco-ai/sidecar@latest` or a semver range cause lag/freshness issues?
3. **Platform triple coverage**: npm package uses `os`/`cpu` fields in `optionalDependencies` to select the right binary. Does this integrate cleanly with Tauri, or does Tauri need extra config?
4. **Offline / air-gapped**: both paths handle this the same way (binary is bundled), but worth confirming.
5. **Migration path**: can we deprecate `stageSidecar.mjs` gradually, or does it need to coexist during a transition window?

## Not in scope for this issue

Actually implementing the switch — this is an investigation only.

## Reference

- Current staging: `clients/taco-desktop/scripts/stageSidecar.mjs`
- npm packages: `@taco-ai/sidecar`, `@taco-ai/sidecar-darwin-arm64`, etc.
- CI: `.github/workflows/release-sidecar.yml`
