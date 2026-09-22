/**
 * Prompt-cache fingerprint — hash / break classification.
 *
 *   pnpm --filter @taco-ai/sidecar test -- tests/runtime/promptCacheFingerprint.test.ts
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
    fingerprintPayload,
    MAX_TRACKED_FINGERPRINT_KEYS,
    recordPromptCacheFingerprint,
    resetPromptCacheFingerprints,
} from "../../src/runtime/harness/promptCacheFingerprint.ts";

afterEach(() => {
    resetPromptCacheFingerprints();
});

const basePayload = {
    system: "you are taco",
    tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

describe("fingerprintPayload", () => {
    it("is stable for identical payloads", () => {
        const a = fingerprintPayload(basePayload);
        const b = fingerprintPayload({ ...basePayload, tools: [...basePayload.tools] });
        assert.equal(a.systemHash, b.systemHash);
        assert.equal(a.toolsHash, b.toolsHash);
        assert.equal(a.messages0Hash, b.messages0Hash);
        assert.deepEqual(a.toolNames, ["read"]);
    });

    it("changes toolsHash when a tool description changes", () => {
        const a = fingerprintPayload(basePayload);
        const b = fingerprintPayload({
            ...basePayload,
            tools: [{ name: "read", description: "different", parameters: { type: "object" } }],
        });
        assert.equal(a.systemHash, b.systemHash);
        assert.notEqual(a.toolsHash, b.toolsHash);
        assert.notEqual(a.perToolHashes.read, b.perToolHashes.read);
    });
});

describe("recordPromptCacheFingerprint", () => {
    it("returns null on the first call (baseline)", () => {
        assert.equal(recordPromptCacheFingerprint("s1:main", basePayload), null);
    });

    it("reports no break on an identical second call", () => {
        recordPromptCacheFingerprint("s1:main", basePayload);
        const br = recordPromptCacheFingerprint("s1:main", basePayload);
        assert.ok(br);
        assert.equal(br.systemChanged, false);
        assert.equal(br.toolsChanged, false);
        assert.equal(br.messages0Changed, false);
        assert.equal(br.toolOrderChanged, false);
    });

    it("names a messages[0] change without flagging tools", () => {
        recordPromptCacheFingerprint("s1:main", basePayload);
        const br = recordPromptCacheFingerprint("s1:main", {
            ...basePayload,
            messages: [{ role: "user", content: [{ type: "text", text: "other" }] }],
        });
        assert.ok(br);
        assert.equal(br.messages0Changed, true);
        assert.equal(br.toolsChanged, false);
        assert.equal(br.systemChanged, false);
    });

    it("flags same-set reordering as toolOrderChanged", () => {
        const two = {
            ...basePayload,
            tools: [
                { name: "read", description: "a", parameters: {} },
                { name: "write", description: "b", parameters: {} },
            ],
        };
        recordPromptCacheFingerprint("s1:main", two);
        const br = recordPromptCacheFingerprint("s1:main", {
            ...two,
            tools: [two.tools[1], two.tools[0]],
        });
        assert.ok(br);
        assert.equal(br.toolOrderChanged, true);
        assert.equal(br.addedTools.length, 0);
        assert.equal(br.removedTools.length, 0);
        assert.deepEqual(br.changedToolSchemas, []);
    });

    it("isolates keys so two sessions do not share state", () => {
        recordPromptCacheFingerprint("s1:main", basePayload);
        assert.equal(recordPromptCacheFingerprint("s2:main", basePayload), null);
    });

    it("evicts the least-recently used key, not the first inserted", () => {
        recordPromptCacheFingerprint("parent:main", basePayload);
        for (let i = 0; i < MAX_TRACKED_FINGERPRINT_KEYS; i++) {
            recordPromptCacheFingerprint(`child-${i}:main`, basePayload);
            // Keep the parent live so it is not the LRU victim.
            recordPromptCacheFingerprint("parent:main", basePayload);
        }
        const br = recordPromptCacheFingerprint("parent:main", {
            ...basePayload,
            messages: [{ role: "user", content: [{ type: "text", text: "moved" }] }],
        });
        assert.ok(br, "parent must still be tracked after a child burst");
        assert.equal(br.messages0Changed, true);
        assert.equal(br.systemChanged, false);
    });
});
