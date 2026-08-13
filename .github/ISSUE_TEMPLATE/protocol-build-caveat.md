---
name: "docs: @taco-ai/protocol build note"
about: Documents a known limitation when publishing @taco-ai/protocol
title: "[sidecar] @taco-ai/protocol build caveat: dist/ must exist before npm pack"
labels: "documentation,sidecar"
---

## Description

`@taco-ai/protocol` and `@taco-ai/shared` are TypeScript-only packages. They ship with a `tsconfig.build.json` that outputs to `dist/`. Before running `npm pack` or `npm publish`, the packages must be built:

```bash
pnpm protocol:build && pnpm shared:build
```

The `files: ["dist"]` field in each `package.json` ensures only the built output is included in the tarball, not the source `.ts` files.

## CI note

The `release-sidecar.yml` workflow runs `pnpm protocol:build && pnpm shared:build` before the publish step in both the `build-libs` job (uploads artifacts) and the `publish` job (publishes directly).

## Reference

- `packages/protocol/tsconfig.build.json`
- `packages/shared/tsconfig.build.json`
- `packages/protocol/package.json` (`files: ["dist"]`)
- `packages/shared/package.json` (`files: ["dist"]`)
