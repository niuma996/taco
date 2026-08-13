/**
 * attachGuard — ensureAttached / requireAttached failure semantics.
 *
 * ensureAttached must propagate whatever workspace.attach throws (so the
 * dispatcher's normalizeError surfaces it as an RPC error). requireAttached
 * must throw RpcHandlerError("invalid_state") for a missing attached session.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/attachGuard.test.ts
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ensureAttached, requireAttached } from "../../../src/server/handlers/attachGuard.ts";
import { RpcHandlerError } from "../../../src/server/methodRegistry.ts";

describe("requireAttached", () => {
    it("throws invalid_state when no attached session exists", () => {
        const workspace = {
            getAttached: () => undefined,
        };
        assert.throws(
            () => requireAttached(workspace as never, "sess-1"),
            (e: unknown) =>
                e instanceof RpcHandlerError &&
                e.code === "invalid_state" &&
                /not attached/i.test(e.message),
        );
    });

    it("returns the attached session when one exists", () => {
        const attached = { session: "stub" };
        const workspace = {
            getAttached: () => attached,
        };
        assert.equal(requireAttached(workspace as never, "sess-1"), attached);
    });
});

describe("ensureAttached", () => {
    it("attaches lazily when no attached session exists", async () => {
        let attached: { id: string } | undefined;
        const workspace = {
            getAttached: () => attached,
            async attach(id: string) {
                attached = { id };
                return attached;
            },
        };
        const result = await ensureAttached(workspace as never, "sess-2");
        assert.deepEqual(result, { id: "sess-2" });
    });

    it("returns the existing attached session without re-attaching", async () => {
        let attachCalls = 0;
        const existing = { id: "sess-3" };
        const workspace = {
            getAttached: () => existing,
            async attach() {
                attachCalls++;
                return existing;
            },
        };
        const result = await ensureAttached(workspace as never, "sess-3");
        assert.equal(result, existing);
        assert.equal(attachCalls, 0, "attach must not be called when already attached");
    });

    it("propagates workspace.attach failures as-is", async () => {
        const workspace = {
            getAttached: () => undefined,
            async attach() {
                throw new Error("disk full");
            },
        };
        await assert.rejects(
            () => ensureAttached(workspace as never, "sess-4"),
            (e: unknown) => e instanceof Error && e.message === "disk full",
        );
    });
});
