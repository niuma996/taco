/**
 * useSessionContextInfo — the snapshot/session pairing.
 *
 * The failure this guards: a refresh issued for the previous session
 * resolves *after* the user switched, overwrites the new session's snapshot,
 * and the `infoSessionId` gate then hides the fresh data too — the context
 * indicator stays blank until the next push event re-pulls.
 */

import type { SessionContextInfoResult } from "@taco-ai/protocol";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSessionContextInfo } from "../../src/hooks/useSessionContextInfo.ts";
import type { TacoClient } from "../../src/lib/clients/tacoClient.ts";

function snapshot(modelId: string, provider: string): SessionContextInfoResult {
    return {
        modelId,
        provider,
        contextWindow: 200_000,
        usedTokens: 1_000,
        ratio: 0.005,
    };
}

/** A client whose sessionContextInfo calls stay pending until resolved by id. */
function makeClient() {
    const pending = new Map<string, (result: SessionContextInfoResult) => void>();
    const client = {
        sessionContextInfo: vi.fn(
            ({ sessionId }: { sessionId: string }) =>
                new Promise<SessionContextInfoResult>((resolve) => {
                    pending.set(sessionId, resolve);
                }),
        ),
        onPush: vi.fn(() => () => {}),
        onWorkspaceEpochChanged: vi.fn(() => () => {}),
    } as unknown as TacoClient;
    return { client, pending };
}

describe("useSessionContextInfo", () => {
    it("keeps the current session's snapshot when an older response lands late", async () => {
        const { client, pending } = makeClient();
        const { result, rerender } = renderHook(
            ({ sessionId }: { sessionId: string }) =>
                useSessionContextInfo(client, "/tmp/ws", sessionId),
            { initialProps: { sessionId: "session-a" } },
        );

        // The user switches sessions while session-a's request is still in
        // flight — session-b's request goes out behind it.
        rerender({ sessionId: "session-b" });
        expect(result.current.info).toBeNull();

        await act(async () => {
            pending.get("session-b")?.(snapshot("model-b", "provider-b"));
            await Promise.resolve();
        });
        expect(result.current.info?.modelId).toBe("model-b");

        // The stale response arrives after the fact. It belongs to a session
        // the user already left — it must not displace the current snapshot.
        await act(async () => {
            pending.get("session-a")?.(snapshot("model-a", "provider-a"));
            await Promise.resolve();
        });
        expect(result.current.info?.modelId).toBe("model-b");
    });

    it("shows the snapshot of the session it was fetched for", async () => {
        const { client, pending } = makeClient();
        const { result } = renderHook(() => useSessionContextInfo(client, "/tmp/ws", "session-a"));

        await act(async () => {
            pending.get("session-a")?.(snapshot("model-a", "provider-a"));
            await Promise.resolve();
        });
        expect(result.current.info?.modelId).toBe("model-a");
        expect(result.current.info?.provider).toBe("provider-a");
    });
});
