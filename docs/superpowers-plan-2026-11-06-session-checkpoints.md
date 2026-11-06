# Session Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one assistant edit turn produce one session-bound checkpoint, expose it in the originating chat turn, and only allow safe restores when files have not changed since the edit.

**Architecture:** The checkpoint manager owns one mutable checkpoint per active turn and adds newly touched files to it. The store persists v2 metadata with session and message anchors plus post-write file hashes, while restore validates those hashes before changing files. The desktop consumes checkpoint data by session and renders a compact edit summary on the closing assistant message; the existing pane becomes grouped recovery history.

**Tech Stack:** TypeScript, Node test runner, React, existing Taco RPC protocol and CSS tokens.

---

### Task 1: Fix checkpoint aggregation

**Files:**
- Modify: `packages/sidecar/src/checkpoints/store.ts`
- Modify: `packages/sidecar/src/checkpoints/manager.ts`
- Test: `packages/sidecar/tests/checkpoints/checkpoints.test.ts`

- [ ] Add failing tests for one turn containing multiple files, merge behavior, and post-write hash capture.
- [ ] Run the checkpoint tests and verify the new assertions fail because `create()` currently emits one record per path.
- [ ] Add a checkpoint update API and manager turn state that creates one record and adds files to it.
- [ ] Capture post-write hashes when the turn closes.
- [ ] Run the checkpoint tests and verify they pass.

### Task 2: Add restore conflict validation

**Files:**
- Modify: `packages/sidecar/src/checkpoints/store.ts`
- Modify: `packages/sidecar/src/runtime/workspace.ts`
- Modify: `packages/sidecar/src/server/handlers/checkpoints.ts`
- Modify: `packages/protocol/src/memory.ts`
- Test: `packages/sidecar/tests/checkpoints/checkpoints.test.ts`

- [ ] Add failing tests showing a changed file is reported as a conflict and untouched files restore.
- [ ] Run the focused tests and verify the conflict assertions fail.
- [ ] Implement current-hash validation and a `conflicts` result; keep legacy checkpoints conservatively restorable with an explicit unsafe flag only for the existing recovery pane.
- [ ] Run sidecar checkpoint and handler tests.

### Task 3: Bind checkpoints to session messages

**Files:**
- Modify: `packages/protocol/src/memory.ts`
- Modify: `packages/protocol/src/schemas/memory.ts`
- Modify: `packages/sidecar/src/checkpoints/manager.ts`
- Modify: `packages/sidecar/src/runtime/harness/turnBookkeeping.ts`
- Modify: `packages/sidecar/src/runtime/harness/attachedSession.ts`
- Test: `packages/sidecar/tests/checkpoints/checkpoints.test.ts`

- [ ] Add failing tests for session id, edit run id, and assistant entry anchor metadata.
- [ ] Run focused tests and verify metadata is missing.
- [ ] Thread the active run id and completed assistant entry id into manager finalization and wire restore metadata through the store.
- [ ] Run sidecar tests and typecheck.

### Task 4: Render checkpoint status inside chat

**Files:**
- Modify: `clients/taco-desktop/src/lib/chat/chatUtils.ts`
- Modify: `clients/taco-desktop/src/lib/chat/workspaceReducer.ts`
- Modify: `clients/taco-desktop/src/components/Message.tsx`
- Modify: `clients/taco-desktop/src/components/MessageMeta.tsx`
- Modify: `clients/taco-desktop/src/hooks/useCheckpointsPane.ts`
- Modify: `clients/taco-desktop/src/views/ChatPane.tsx`
- Modify: `clients/taco-desktop/src/i18n/locales/zh.json`
- Modify: `clients/taco-desktop/src/i18n/locales/en.json`
- Modify: `clients/taco-desktop/src/styles/checkpointsPane.css`
- Test: `clients/taco-desktop/tests/lib/chat/chatUtils.test.ts`

- [ ] Add failing pure-function tests for grouping checkpoint data by session and attaching it to an entry id.
- [ ] Run the client tests and verify they fail.
- [ ] Fetch session-scoped checkpoint data while chat is active and render an edit summary on the closing assistant message with guarded restore confirmation.
- [ ] Run client tests and desktop typecheck.

### Task 5: Group recovery history and verify

**Files:**
- Modify: `clients/taco-desktop/src/views/CheckpointsPane.tsx`
- Modify: `clients/taco-desktop/src/hooks/useCheckpointsPane.ts`
- Modify: `clients/taco-desktop/src/i18n/locales/zh.json`
- Modify: `clients/taco-desktop/src/i18n/locales/en.json`
- Test: `clients/taco-desktop/tests/views/CheckpointsPane.test.tsx`

- [ ] Add failing view tests for session grouping, current-session restore, and conflict copy.
- [ ] Implement grouped recovery history with an open-chat action and no direct restore for an unrelated session.
- [ ] Run focused tests, desktop typecheck, and package tests.
- [ ] Review the diff against this plan and run the final verification commands.
