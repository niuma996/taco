# Contributing to Taco

Thanks for taking the time to improve Taco. This document covers what
you need to make a clean PR. The detailed conventions in
[`CLAUDE.md`](CLAUDE.md) are load-bearing — read them first.

## Project conventions (read first)

- **Language.** Use **English** for all source code, comments, commit
  messages, identifiers, and issue/PR text. Use **Chinese** in
  user-facing product strings (the desktop UI is bilingual; ship
  en + zh together unless your change is purely internal).
- **Module system.** The whole repo is ESM. Use `node:` builtins, no
  `require()`, no default exports. See `CLAUDE.md §Module System`.
- **File naming.** `camelCase.ts` for sources, `PascalCase.tsx` for
  React components, `kebab-case/` for directories.
- **Imports.** `.ts` in `packages/sidecar/src`, `.js` in
  `packages/{shared,protocol}`, no extension in `clients/*/src`. Never
  `require()`.

## Dev setup

Prerequisites: Node `>=22` (`.node-version`), `pnpm@11.5.0`
(`packageManager` in `package.json`).

```bash
git clone <repo> taco
cd taco
pnpm install
```

`pnpm install` resolves all five workspace packages
(`@taco-ai/{protocol,shared,sidecar,debug-console,desktop}`) and the
Pi runtime.

### First-time checks

```bash
pnpm typecheck      # tsc -p tsconfig.json --noEmit, whole repo
pnpm lint           # biome check .
pnpm lint:comments  # scripts/check-comments.mjs (staleness)
pnpm test           # node --test across packages + clients
```

All four must pass before opening a PR.

## Daily workflow

### Branching

```bash
git checkout -b codex/<short-topic>
```

Examples: `codex/fix-session-attached-race`,
`codex/docs-mcp-reload`.

Commit messages follow Conventional Commits (the project uses scopes
to mirror directory layout):

```
feat(sidecar): add session.taskHistory.get handler
fix(desktop): debounce chat input during compacting
docs(protocol): regenerate sidecar-protocol.md
chore(sidecar): drop legacy IM_DISABLED_FS_TOOLS export
refactor(shared): split TacoClientBase dispatch wiring
test(sidecar): cover commandId dedupe under concurrent prompts
```

### Before opening a PR

Run in order:

1. `pnpm typecheck` — must be clean.
2. `pnpm lint` — biome must be clean (auto-format with
   `pnpm exec biome check --write .` if needed).
3. `pnpm test` — all tests pass. If you changed protocol types or RPC
   method names, also run `pnpm sidecar:docs` and commit the
   regenerated `docs/sidecar-protocol.md`.
4. `pnpm pack:smoke` — only when your change touches
   `packages/{protocol,shared,sidecar}` `package.json` / build config.
   This is what CI runs on the release path.
5. **Manual verification** — anything user-visible should be checked
   end-to-end. For the desktop, `pnpm tauri:dev` runs against the
   sidecar source (debug builds), so edits take effect without
   re-staging.

### PR description

Use this template:

```markdown
## What
One paragraph: what changed and why.

## How
Bullets or short prose: the design choices that aren't obvious from
the diff.

## Verification
- [ ] pnpm typecheck
- [ ] pnpm lint
- [ ] pnpm test
- [ ] manual repro of the original issue
- [ ] (if RPC/protocol) pnpm sidecar:docs regenerated
- [ ] (if release-affecting) pnpm pack:smoke

## Risk
Anything that could regress: sidecar lifecycle, push-stream dedup,
permission broker decisions, MCP server lifecycle, IM channel state
machine.
```

A reviewer should be able to read "What + Risk" and know whether to
approve without opening the diff.

### Reviewing

Two approvals are required for changes touching:

- `packages/sidecar/src/server/**` (handler dispatch, push wiring,
  commandId dedup)
- `packages/protocol/src/**` (wire contract — any change here breaks
  every downstream client)
- `packages/shared/**` (`TacoClientBase` and the typed RPC surface
  are consumed by every client)
- `clients/taco-desktop/src-tauri/**` (Rust process management)
- `clients/taco-desktop/src/lib/tacoClient.ts` (Tauri transport
  state machine)

Other changes need one approval. Use the GitHub suggestion block for
small fixes; re-request review after addressing comments.

## Adding a new RPC

1. Add the name to `packages/shared/rpcMethods.ts` under the matching
   namespace.
2. Define request / response types in the appropriate
   `packages/protocol/src/<domain>.ts` file.
3. Register the handler in
   `packages/sidecar/src/server/handlers/<domain>.ts` via
   `registerMethod(name, ensureWorkspace, async (ctx) => {...},
   options)`. Pick `options.command = true` for mutating writes,
   `options.turnStart = true` if it should serialize against an
   active model turn.
4. Add the typed wrapper in `packages/shared/typedRpc.ts`. The
   `helpers` block at the top shows the four common shapes
   (`ws0 / wsSession / process0 / process1`); non-standard param
   shapes are inlined.
5. Run `pnpm sidecar:docs` and commit the regenerated
   `docs/sidecar-protocol.md`.

## Adding a new IM channel

1. Add a manifest to `packages/sidecar/src/channels/builtinManifests.ts`.
2. Add a `case` in
   `packages/sidecar/src/channels/channelFactory.ts` that
   dynamic-imports your SDK module. If the SDK is optional, throw an
   `SdkMissingError`-style typed error so the desktop can surface a
   "install SDK" affordance.
3. Implement `Channel` + `ChannelHandle` from
   `packages/sidecar/src/channels/types.ts`.
4. If the channel needs an interactive bind flow (QR / pairing code),
   use `ChannelBindBroker.requestScan` / `requestVerifyCode` — do NOT
   invent a new reverse-request channel; the protocol is
   one-directional.

## Adding a new built-in extension

1. Create `packages/sidecar/src/extensions/builtin/<name>/index.ts`
   with a default export matching the `ExtensionModule` shape.
2. Register the manifest in
   `packages/sidecar/src/extensions/builtin/manifest.ts`.
3. If it injects tag content, register the tag spec via
   `registry.addExtensionTag(name, tagName, spec)` — tags declared
   outside this path will not survive `tuiVisibility` filtering.

For security issues, do NOT open a public issue — follow
[`SECURITY.md`](SECURITY.md).