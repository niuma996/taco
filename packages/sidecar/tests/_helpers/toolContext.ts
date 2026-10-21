/**
 * Tool-context fixtures for tests.
 *
 * The session identity (sessionId / sessionKind / isIm) is part of the tool
 * context because a tool that changes global state must know who is asking.
 * Tests that only need the environment reach for `baseToolContext`; the ones
 * that exercise a session-scoped tool use `sessionToolContext`.
 */
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import type { TacoToolContext, TacoToolContextBase } from "../../src/tools/context.ts";

/** The workspace-level part only — what `getToolContext` returns. */
export function baseToolContext(overrides: Partial<TacoToolContextBase> = {}): TacoToolContextBase {
    return {
        env: undefined as never,
        workspace: asWorkspaceId("/tmp/test"),
        ...overrides,
    };
}

/** A full tool context, as a main local session sees it. */
export function sessionToolContext(overrides: Partial<TacoToolContext> = {}): TacoToolContext {
    return {
        ...baseToolContext(),
        sessionId: asSessionId("test-session"),
        sessionKind: "main",
        isIm: false,
        ...overrides,
    };
}
