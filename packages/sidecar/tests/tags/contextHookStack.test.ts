/**
 * Context hook stack — integration test.
 *
 * Reproduces pi-agent-core's last-writer-wins emitHook semantics and verifies
 * that all hooks' mutations compose correctly when each hook mutates
 * event.messages in-place and returns { messages: event.messages }.
 *
 * Run:
 *   pnpm --filter @taco-ai/sidecar test:tags
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { buildCompactionReminderHook } from "../../src/tags/compactionReminder.ts";
import {
    buildDropPolicyContextHook,
    buildStripThinkingContextHook,
} from "../../src/tags/convertToLlm.ts";
import { buildEnvContextHook } from "../../src/tags/envContext.ts";
import { buildImChannelContextHook } from "../../src/tags/imChannelContext.ts";
import { buildInstructionsContextHook } from "../../src/tags/instructionsContext.ts";
import { buildReplyLanguageContextHook } from "../../src/tags/replyLanguage.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeUserMessage(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function allText(messages: AgentMessage[]): string {
    return messages
        .map((m) => {
            const c = (m as { content?: unknown }).content;
            if (typeof c === "string") return c;
            if (Array.isArray(c))
                return (c as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
            return "";
        })
        .join("\n");
}

/**
 * Reproduce pi-agent-core emitHook last-writer-wins semantics.
 * All handlers receive the SAME event object. Only the last non-undefined
 * return value is kept — so each handler MUST mutate event.messages in-place
 * and return { messages: event.messages } for mutations to compose.
 *
 * NOTE: if upstream changes emitHook semantics (e.g., accumulator instead of
 * last-writer-wins), these tests will keep passing while production drifts.
 */
function emitContextHooks(
    // Hooks typed against pi's full `ContextEvent` (with `type: "context"`)
    // are accepted here through `unknown` — the helper is for in-place
    // mutation testing only and does not actually exercise the harness's
    // `type` dispatch.
    hooks: Array<unknown>,
    messages: AgentMessage[],
): AgentMessage[] {
    const event = { messages: [...messages] };
    let lastResult: { messages: AgentMessage[] } | undefined;
    for (const h of hooks) {
        const r = (h as (e: typeof event) => unknown)(event);
        if (r && !(r instanceof Promise) && r !== undefined) {
            lastResult = r as { messages: AgentMessage[] };
        }
    }
    return lastResult?.messages ?? event.messages;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("context hook stack (emitHook last-writer-wins)", () => {
    let tmpDir: string;

    before(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-hook-stack-"));
        writeFileSync(join(tmpDir, "CLAUDE.md"), "# Test CLAUDE.md\nBe concise.", "utf-8");
    });

    after(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("all hooks compose: checks presence of instructions, env, reply_language", async () => {
        const drop = buildDropPolicyContextHook();
        const instr = buildInstructionsContextHook({
            cwd: tmpDir,
            getConfig: () => undefined,
        });
        const env = buildEnvContextHook();
        const imChannel = buildImChannelContextHook(() => ({
            type: "wechat",
            channelId: "wechat-main",
        }));
        const reply = buildReplyLanguageContextHook(() => "zh");
        const thinking = buildStripThinkingContextHook(() => "medium");

        const original = [makeUserMessage("execute task")];
        const final = emitContextHooks([drop, instr, env, imChannel, reply, thinking], original);
        const text = allText(final);

        assert.ok(text.includes("<instructions"), "must contain <instructions> tag");
        assert.ok(text.includes("<env>"), "must contain <env> tag");
        assert.ok(text.includes("<reply_language>"), "must contain <reply_language> tag");
        assert.ok(text.includes("<im_channel>"), "must contain <im_channel> tag");
        assert.ok(text.includes("type: wechat"), "im_channel exposes platform type");
        assert.ok(text.includes("channel_id: wechat-main"), "im_channel exposes channel id");
        assert.ok(text.includes("execute task"), "original user message must survive");
    });

    it("im_channel hook is a no-op outside an IM workspace", () => {
        const drop = buildDropPolicyContextHook();
        const imChannel = buildImChannelContextHook(() => undefined);
        const reply = buildReplyLanguageContextHook(() => "zh");
        const env = buildEnvContextHook();

        const original = [makeUserMessage("fs workspace message")];
        const final = emitContextHooks([drop, imChannel, reply, env], original);
        const text = allText(final);

        assert.ok(!text.includes("<im_channel>"), "no im_channel for non-IM workspace");
        assert.ok(text.includes("fs workspace message"), "original message survives");
    });

    it("unshift order matches registration order (last hook → position 0)", async () => {
        const drop = buildDropPolicyContextHook();
        const reply = buildReplyLanguageContextHook(() => "en");
        const env = buildEnvContextHook();

        const original = [makeUserMessage("test")];
        const final = emitContextHooks([drop, reply, env], original);
        const texts = final.map((m) => {
            const c = (m as { content?: unknown }).content;
            if (Array.isArray(c))
                return (c as Array<{ text?: string }>)[0]?.text?.slice(0, 30) ?? "";
            return String(c).slice(0, 30);
        });

        // Expected: [<reply_language>, env is at tail（push）, original user msg]
        // reply unshifts → position 0. env pushes → at end.
        assert.ok(
            texts[0].includes("<reply_language>"),
            `msg[0] should be <reply_language>, got: ${texts[0]}`,
        );
        assert.ok(texts[texts.length - 1].includes("<env>"), "last msg should be <env>");
    });

    it("env hook pushes to tail (not unshift) — P2: stable prefix", () => {
        const env = buildEnvContextHook();
        const original = [makeUserMessage("first"), makeUserMessage("last")];
        const final = emitContextHooks([env], original);
        const texts = final.map((m) => {
            const c = (m as { content?: unknown }).content;
            if (Array.isArray(c))
                return (c as Array<{ text?: string }>)[0]?.text?.slice(0, 30) ?? "";
            return String(c).slice(0, 30);
        });

        assert.equal(final.length, 3);
        assert.ok(texts[0].includes("first"), `msg[0] should be original first, got: ${texts[0]}`);
        assert.ok(texts[2].includes("<env>"), `msg[2] should be <env>, got: ${texts[2]}`);
    });

    it("strip hooks mutate messages in-place with correct order", async () => {
        const drop = buildDropPolicyContextHook();
        const thinking = buildStripThinkingContextHook(() => "off");
        const instr = buildInstructionsContextHook({
            cwd: tmpDir,
            getConfig: () => undefined,
        });

        const original = [makeUserMessage("hello")];
        const final = emitContextHooks([drop, thinking, instr], original);

        const text = allText(final);
        assert.ok(text.includes("<instructions"), "instructions must be present");
        assert.ok(text.includes("hello"), "original message must survive");
    });

    it("conditional hooks return undefined yet mutations from prior hooks persist", async () => {
        const instr = buildInstructionsContextHook({
            cwd: tmpDir,
            getConfig: () => undefined,
        });
        const env = buildEnvContextHook();
        const reply = buildReplyLanguageContextHook(() => undefined); // returns undefined
        const thinking = buildStripThinkingContextHook(() => "medium"); // returns undefined

        const original = [makeUserMessage("msg")];
        const final = emitContextHooks([instr, env, reply, thinking], original);
        const text = allText(final);

        assert.ok(text.includes("<instructions"), "instructions survives reply → undefined");
        assert.ok(text.includes("<env>"), "env survives even though reply returned undefined");
        assert.ok(!text.includes("<reply_language>"), "reply_language should NOT appear");
    });

    it("all hooks return undefined → transformContext fallback keeps mutations", () => {
        const env = buildEnvContextHook();
        const reply = buildReplyLanguageContextHook(() => undefined);
        const thinking = buildStripThinkingContextHook(() => "medium");
        const safetyNet = (event: { messages: AgentMessage[] }) => ({
            messages: event.messages,
        });

        const original = [makeUserMessage("msg")];
        const final = emitContextHooks([env, reply, thinking, safetyNet], original);
        const text = allText(final);

        assert.ok(
            text.includes("<env>"),
            "env mutation survives even though earlier hooks returned undefined",
        );
    });
});

describe("compaction reminder", () => {
    it("fires once after notify then resets", () => {
        const { hook: reminder, notify } = buildCompactionReminderHook();

        const original = [makeUserMessage("x")];
        const r1 = reminder({ type: "context", messages: original });
        assert.equal(r1, undefined, "no notify → undefined");

        notify();
        const r2 = reminder({ type: "context", messages: original });
        assert.ok(r2, "after notify → must inject");
        assert.ok(allText(r2.messages).includes("<compaction_reminder>"), "must contain reminder");

        const r3 = reminder({ type: "context", messages: original });
        assert.equal(r3, undefined, "after first fire → reset to undefined");
    });
});
