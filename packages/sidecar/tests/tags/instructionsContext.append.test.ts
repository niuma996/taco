/**
 * Instructions hook — append + skip-if-already-present.
 *
 *   pnpm --filter @taco-ai/sidecar test -- tests/tags/instructionsContext.append.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { AgentMessage } from "../../src/runtime/pi/types.ts";
import { buildInstructionsContextHook } from "../../src/tags/instructionsContext.ts";

function userMsg(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function textOf(msg: AgentMessage): string {
    const c = (msg as { content?: unknown }).content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return (c as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
    return "";
}

describe("buildInstructionsContextHook append contract", () => {
    let dir: string;

    before(() => {
        dir = mkdtempSync(join(tmpdir(), "instr-append-"));
        writeFileSync(join(dir, "CLAUDE.md"), "Be concise.", "utf-8");
    });

    after(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("appends the tag and leaves messages[0] as the original user", () => {
        const hook = buildInstructionsContextHook({ cwd: dir, getConfig: () => undefined });
        const original = userMsg("hello");
        const result = hook({ messages: [original] });
        assert.ok(result);
        const injected = result.messages ?? [];
        assert.equal(injected[0], original);
        assert.ok(textOf(injected[1] as AgentMessage).includes("<instructions"));
        assert.ok(textOf(injected[1] as AgentMessage).includes("Be concise."));
    });

    it("does not re-append when the same block is already in the window", () => {
        const hook = buildInstructionsContextHook({ cwd: dir, getConfig: () => undefined });
        const first = hook({ messages: [userMsg("hello")] });
        assert.ok(first);
        const firstMessages = first.messages ?? [];
        const second = hook({ messages: firstMessages });
        assert.equal(second, undefined);
        assert.equal(firstMessages.filter((m) => textOf(m).includes("<instructions")).length, 1);
    });

    it("does not re-append when the same block is nested inside another user message", () => {
        const hook = buildInstructionsContextHook({ cwd: dir, getConfig: () => undefined });
        const first = hook({ messages: [userMsg("hello")] });
        assert.ok(first);
        const tag = textOf((first.messages ?? [])[1] as AgentMessage);
        assert.ok(tag.includes("<instructions"));
        // Compaction / pin-aware compact may concatenate the tag into a later
        // user message. Dedup must still recognise the inner block.
        const wrapped = userMsg(`preamble\n${tag}\ntrailer`);
        const second = hook({ messages: [userMsg("next"), wrapped] });
        assert.equal(second, undefined);
    });
});
