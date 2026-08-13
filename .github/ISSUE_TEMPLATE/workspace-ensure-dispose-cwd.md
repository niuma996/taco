---
name: "[已修复] workspace.ensure / workspace.dispose routing"
about: Closed / audit-trail only. The bug is fixed; please use a different template.
title: "[已修复] workspace.ensure / workspace.dispose routing (audit trail)"
labels: "documentation,sidecar"
---

## Status

**Closed — audit trail only.** The issue described below was fixed in
commit `workspaceParam: "cwd"` (pre-1.0). The regression test is
[`packages/sidecar/tests/server/workspaceRouting.test.ts`](../../packages/sidecar/tests/server/workspaceRouting.test.ts).

If you are seeing a *new* symptom around `workspace.ensure` /
`workspace.dispose`, please open a fresh issue with a concrete
reproducer (the sidecar version, the full NDJSON exchange, and the
error code) — this template is kept only so the existing GitHub issue
#N has a home.

## Original description (for reference)

> `workspace.ensure` and `workspace.dispose` are registered with
> `ensureWorkspace: false`, so the RPC dispatcher does not parse the
> `cwd` param. The handlers receive `ctx.cwd = "*"` regardless of what
> the client sends. The current implementation therefore operates on
> a workspace literally named `"*"`.

## Fix

Both methods are registered with `{ workspaceParam: "cwd", command: true }`,
so the dispatcher parses `params.cwd` and forwards it as the routing
key. See `handlers/workspace.ts`.

## Reference

- Handler registration: `packages/sidecar/src/server/handlers/workspace.ts`
- Regression test: `packages/sidecar/tests/server/workspaceRouting.test.ts`
- Handler dispatcher: `packages/sidecar/src/server/methodRegistry.ts`
