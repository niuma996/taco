/**
 * memory tool — schema-level tests.
 *
 * Guards against the failure mode where the model first sent a flat-string action
 * but the old schema demanded a nested object, and then sent a snake_case id
 * instead of kebab-case.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MemoryUpsertParams } from "@taco-ai/protocol";
import { MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";
import { Value } from "typebox/value";
import { createMemoryTool, type MemoryToolInput } from "../../src/tools/memory.ts";

const VALID: MemoryToolInput = {
    action: "add",
    id: "web-search-preference",
    name: "Web search default",
    description: "Default to mmx-cli for web search",
    content: "Use mmx-cli skill by default.",
    type: "user",
};

describe("memory tool schema", () => {
    const tool = createMemoryTool({
        workspace: "/tmp/ws",
        async call() {
            throw new Error("call() should not run in schema tests");
        },
    });

    it("accepts flat envelope (action at top level)", () => {
        assert.equal(Value.Check(tool.parameters, VALID), true);
    });

    it("rejects the legacy nested shape ({action: {action: 'add', ...}})", () => {
        const legacyNested = {
            action: {
                action: "add",
                id: "web-search-preference",
                name: "x",
                content: "y",
                type: "user",
            },
        };
        // The legacy shape is invalid because top-level `action` is now the
        // dispatch string, not an envelope object — so other required keys
        // (id, name, content, type) appear missing.
        assert.equal(Value.Check(tool.parameters, legacyNested), false);
    });

    it("rejects kebab-case violations on id (snake_case, uppercase, spaces, empty, overlong)", () => {
        // The handler whitelists `^[a-z0-9-]+$` — any character outside that
        // set makes the sanitized value differ from the input. Our JSON
        // Schema pattern encodes the same whitelist so the LLM never reaches
        // the handler with a bad id.
        for (const badId of [
            "user_web_search_preference", // snake_case — the exact bug from the session
            "UPPER",
            "with space",
            "",
            "x".repeat(65),
            "with.dot",
            "with/slash",
        ]) {
            const input = { ...VALID, id: badId };
            assert.equal(
                Value.Check(tool.parameters, input),
                false,
                `id "${badId}" must be rejected by the JSON Schema pattern`,
            );
        }
    });

    it("accepts a range of valid kebab-case ids (including edge hyphens, matching the handler)", () => {
        // Handler regex is `^[a-z0-9-]+$` (loose kebab). Mirror that — anything
        // composed of lowercase/digits/hyphens, 1-64 chars — so schema and
        // handler agree on what is valid.
        for (const okId of [
            "user-role",
            "feedback-auth",
            "a",
            "abc-123",
            "x".repeat(64),
            "trailing-",
            "-leading",
        ]) {
            assert.equal(
                Value.Check(tool.parameters, { ...VALID, id: okId }),
                true,
                `id "${okId}" must be accepted`,
            );
        }
    });

    it("rejects unknown action values", () => {
        assert.equal(Value.Check(tool.parameters, { ...VALID, action: "delete" }), false);
    });

    it("rejects unknown type values", () => {
        assert.equal(Value.Check(tool.parameters, { ...VALID, type: "misc" }), false);
    });

    it("rejects oversized name/content/description", () => {
        assert.equal(Value.Check(tool.parameters, { ...VALID, name: "x".repeat(61) }), false);
        assert.equal(
            Value.Check(tool.parameters, {
                ...VALID,
                content: "x".repeat(MEMORY_CONTENT_MAX_CHARS + 1),
            }),
            false,
        );
        assert.equal(
            Value.Check(tool.parameters, { ...VALID, description: "x".repeat(121) }),
            false,
        );
    });

    it("description explicitly warns against snake_case id", () => {
        // Belt-and-suspenders: the description should not steer models toward
        // snake_case. The old description ended with `e.g., 'user_role', ...`
        // which directly trained the failure pattern.
        assert.ok(tool.description.includes("kebab-case"), "description must mention kebab-case");
        assert.ok(
            !tool.description.includes("user_role"),
            "description must not include snake_case example",
        );
        assert.ok(
            tool.description.includes("Underscores"),
            "description must explicitly reject underscores",
        );
    });
});

describe("memory tool execute", () => {
    it("dispatches flat params directly to memory.upsert RPC", async () => {
        let captured: MemoryUpsertParams | undefined;
        const tool = createMemoryTool({
            workspace: "/tmp/ws",
            // The deps type is `<P, R>(method, workspace, params) => Promise<R>`,
            // so the mock must preserve `R` as a free type parameter. Casting
            // the captured params is enough for assertions below.
            async call<P, R>(_method: string, _workspace: string, params: P): Promise<R> {
                captured = params as unknown as MemoryUpsertParams;
                return { ok: true, outcome: "created" } as unknown as R;
            },
        });

        const result = await tool.execute("tc-1", VALID, undefined, undefined, {
            env: undefined as never,
        });

        // Critical: the params handed to memory.upsert must be flat, with
        // `action` as a string — not nested under another `action` envelope.
        assert.deepEqual(captured, {
            workspace: "/tmp/ws",
            action: "add",
            id: "web-search-preference",
            name: "Web search default",
            description: "Default to mmx-cli for web search",
            content: "Use mmx-cli skill by default.",
            type: "user",
        });
        assert.equal(
            result.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
            "memory.upsert created: web-search-preference",
        );
        assert.deepEqual(result.details, { ok: true, outcome: "created" });
    });
});
