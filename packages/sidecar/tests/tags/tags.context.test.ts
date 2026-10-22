// Context-hook tag tests: pinned tail, hook stack, pin-aware compaction, IM/env/instructions/reply-language context.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type {
    AgentMessage,
    CompactionPreparation,
    CompactResult,
    Model,
    Models,
} from "../../src/runtime/pi/types.ts";
import { Result } from "../../src/runtime/pi/values.ts";
import {
    buildDropPolicyContextHook,
    buildStripThinkingContextHook,
} from "../../src/tags/convertToLlm.ts";
import { buildEnvContextHook } from "../../src/tags/envContext.ts";
import { extractAndStripPinned, extractPinnedSegments } from "../../src/tags/extractors.ts";
import { buildImChannelContextHook } from "../../src/tags/imChannelContext.ts";
import { buildInstructionsContextHook } from "../../src/tags/instructionsContext.ts";
import {
    buildPinnedDirective,
    buildPinnedTail,
    mergeCompactionInstructions,
} from "../../src/tags/policy/compression.ts";
import { buildPinAwareCompactHook } from "../../src/tags/policy/pinAwareCompact.ts";
import { buildReplyLanguageContextHook } from "../../src/tags/replyLanguage.ts";

interface TaggedMsg {
    readonly role: "user" | "assistant";
    readonly content: string;
}

describe("extractAndStripPinned", () => {
    it("strips a single pinned tag and returns its content verbatim", () => {
        const messages: TaggedMsg[] = [
            {
                role: "user",
                content:
                    'preamble\n<skill_body name="rule">NEVER touch prod DB</skill_body>\npostamble',
            },
        ];
        const result = extractAndStripPinned(messages);
        assert.equal(result.pinned.length, 1);
        assert.equal(result.pinned[0]?.name, "skill_body");
        assert.equal(result.pinned[0]?.content, "NEVER touch prod DB");
        const out = result.strippedMessages[0];
        assert.ok(out);
        assert.equal(out.content.includes("skill_body"), false);
        assert.equal(out.content.includes("NEVER touch prod DB"), false);
        assert.equal(out.content.includes("preamble"), true);
        assert.equal(out.content.includes("postamble"), true);
    });

    it("keeps first-seen only across messages; strips ALL occurrences", () => {
        const messages: TaggedMsg[] = [
            { role: "user", content: '<skill_body name="x">v1</skill_body> alpha' },
            { role: "user", content: 'beta <skill_body name="x">v2</skill_body> gamma' },
        ];
        const result = extractAndStripPinned(messages);
        assert.equal(result.pinned.length, 1);
        assert.equal(result.pinned[0]?.content, "v1");
        assert.equal(result.strippedMessages[0]?.content.includes("v1"), false);
        assert.equal(result.strippedMessages[1]?.content.includes("v2"), false);
        assert.equal(result.strippedMessages[0]?.content.includes("alpha"), true);
        assert.equal(result.strippedMessages[1]?.content.includes("beta"), true);
        assert.equal(result.strippedMessages[1]?.content.includes("gamma"), true);
    });

    it("pins two skill_body tags with different name attrs as distinct segments", () => {
        const messages: TaggedMsg[] = [
            {
                role: "user",
                content:
                    '<skill_body name="alpha">A</skill_body>\n<skill_body name="beta">B</skill_body>',
            },
        ];
        const result = extractAndStripPinned(messages);
        assert.equal(result.pinned.length, 2);
        const names = result.pinned.map((p) => p.attrs.name).sort();
        assert.deepEqual(names, ["alpha", "beta"]);
        assert.equal(result.strippedMessages[0]?.content.includes("skill_body"), false);
    });

    it("does not treat colon-form <skill_body:NAME> as a pin", () => {
        const messages: TaggedMsg[] = [
            { role: "user", content: "<skill_body:demo>\nstale colon form\n</skill_body:demo>" },
        ];
        const result = extractAndStripPinned(messages);
        assert.equal(result.pinned.length, 0);
        assert.equal(
            result.strippedMessages[0]?.content,
            "<skill_body:demo>\nstale colon form\n</skill_body:demo>",
        );
    });

    it("leaves non-pinned tags untouched", () => {
        const messages: TaggedMsg[] = [{ role: "user", content: "<not_a_pin>hello</not_a_pin>" }];
        const result = extractAndStripPinned(messages);
        assert.equal(result.pinned.length, 0);
        // not_a_pin isn't in the registry as pin → stays in place.
        assert.equal(result.strippedMessages[0]?.content, "<not_a_pin>hello</not_a_pin>");
    });

    it("ignores tags inside fenced code blocks", () => {
        // The `<skill_body>...</skill_body>` inside the fenced block
        // must NOT be picked up — `findBalancedTagsSkippingFences` is the parser.
        const fenced = '```\n<skill_body name="s">SECRET</skill_body>\n```';
        const real = '<skill_body name="s">REAL</skill_body>';
        const messages: TaggedMsg[] = [{ role: "user", content: `${fenced}\n${real}` }];
        const result = extractAndStripPinned(messages);
        assert.equal(result.pinned.length, 1);
        assert.equal(result.pinned[0]?.content, "REAL");
        // The fenced body should still be present (it's just a markdown fence).
        assert.equal(result.strippedMessages[0]?.content.includes("SECRET"), true);
        assert.equal(result.strippedMessages[0]?.content.includes("REAL"), false);
    });

    it("preserves messages with non-string content unchanged", () => {
        const messages = [{ role: "user" as const, content: 42 }];
        const result = extractAndStripPinned(messages);
        assert.equal(result.pinned.length, 0);
        assert.deepEqual(result.strippedMessages[0], { role: "user", content: 42 });
    });
});

describe("extractPinnedSegments (read-only)", () => {
    it("returns pinned segments without stripping", () => {
        const text = '<skill_body name="a">A</skill_body> x <ask_user_context>B</ask_user_context>';
        const messages = [
            { role: "user" as const, content: text },
            { role: "user" as const, content: text },
        ];
        const segments = extractPinnedSegments(messages);
        const names = segments.map((s) => s.name).sort();
        assert.deepEqual(names, ["ask_user_context", "skill_body"]);
        // Read-only: original messages must NOT be modified.
        for (const m of messages) {
            assert.ok((m.content as string).includes("<skill_body"));
        }
    });
});

describe("buildPinnedTail", () => {
    it("returns empty string when no segments", () => {
        assert.equal(buildPinnedTail([]), "");
    });

    it("wraps each pinned segment with its tag and a sentinel header", () => {
        const tail = buildPinnedTail([
            {
                name: "instructions",
                content: "follow",
                attrs: {},
                instanceId: "instructions:test",
            },
        ]);
        assert.match(tail, /PINNED \(verbatim/);
        // tagWrap emits `<name>\nbody\n</name>` — accept either exact or with newlines.
        assert.match(tail, /<instructions>\s*\n?follow\n?\s*<\/instructions>/);
    });

    it("preserves tag attributes from the original pinned segment", () => {
        const tail = buildPinnedTail([
            {
                name: "skill_body",
                content: "body",
                attrs: { name: "fix" },
                instanceId: "skill_body:fix",
            },
        ]);
        assert.match(tail, /<skill_body name="fix">\s*\n?body\n?\s*<\/skill_body>/);
    });
});

describe("buildPinnedDirective", () => {
    it("returns null when no tag names", () => {
        assert.equal(buildPinnedDirective([]), null);
    });

    it("lists tag names and forbids quoting their contents", () => {
        const text = buildPinnedDirective(["skill_body", "ask_user_context"]);
        assert.ok(text);
        assert.ok(text.includes("skill_body"));
        assert.ok(text.includes("ask_user_context"));
        assert.ok(text.includes("verbatim"));
        assert.ok(text.includes("do not quote"));
    });
});

describe("mergeCompactionInstructions", () => {
    it("returns undefined when neither side is present", () => {
        assert.equal(mergeCompactionInstructions(undefined, []), undefined);
    });

    it("passes through caller instructions when nothing is pinned", () => {
        assert.equal(mergeCompactionInstructions("be terse", []), "be terse");
    });

    it("uses the pin directive alone for auto-compact", () => {
        const merged = mergeCompactionInstructions(undefined, ["memory"]);
        assert.ok(merged);
        assert.ok(merged.includes("memory"));
        assert.equal(merged.includes("be terse"), false);
    });

    it("keeps caller instructions ahead of the pin directive", () => {
        const merged = mergeCompactionInstructions("be terse", ["memory"]);
        assert.ok(merged);
        assert.ok(merged.startsWith("be terse"));
        assert.ok(merged.includes("memory"));
    });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function makeStackUserMessage(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function allStackText(messages: AgentMessage[]): string {
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

        const original = [makeStackUserMessage("execute task")];
        const final = emitContextHooks([drop, instr, env, imChannel, reply, thinking], original);
        const text = allStackText(final);

        assert.ok(text.includes("<instructions"), "must contain <instructions> tag");
        assert.ok(text.includes('<env as_of="'), "must contain <env> tag");
        assert.ok(text.includes('<reply_language locale="'), "must contain <reply_language> tag");
        assert.ok(text.includes('<im_channel type="'), "must contain <im_channel> tag");
        assert.ok(text.includes("type: wechat"), "im_channel exposes platform type");
        assert.ok(text.includes("channel_id: wechat-main"), "im_channel exposes channel id");
        assert.ok(text.includes("execute task"), "original user message must survive");
    });

    it("im_channel hook is a no-op outside an IM workspace", () => {
        const drop = buildDropPolicyContextHook();
        const imChannel = buildImChannelContextHook(() => undefined);
        const reply = buildReplyLanguageContextHook(() => "zh");
        const env = buildEnvContextHook();

        const original = [makeStackUserMessage("fs workspace message")];
        const final = emitContextHooks([drop, imChannel, reply, env], original);
        const text = allStackText(final);

        assert.ok(!text.includes("<im_channel>"), "no im_channel for non-IM workspace");
        assert.ok(text.includes("fs workspace message"), "original message survives");
    });

    it("live tags append to the tail so messages[0] stays the original user", async () => {
        const drop = buildDropPolicyContextHook();
        const reply = buildReplyLanguageContextHook(() => "en");
        const env = buildEnvContextHook();

        const original = [makeStackUserMessage("test")];
        const final = emitContextHooks([drop, reply, env], original);
        const texts = final.map((m) => {
            const c = (m as { content?: unknown }).content;
            if (Array.isArray(c))
                return (c as Array<{ text?: string }>)[0]?.text?.slice(0, 40) ?? "";
            return String(c).slice(0, 40);
        });

        assert.ok(
            texts[0].includes("test"),
            `msg[0] should be the original user, got: ${texts[0]}`,
        );
        assert.ok(
            texts.some((t) => t.includes('<reply_language locale="')),
            "reply_language must still be injected",
        );
        assert.ok(texts[texts.length - 1].includes('<env as_of="'), "last msg should be <env>");
    });

    it("conditional hooks return undefined yet mutations from prior hooks persist", async () => {
        const instr = buildInstructionsContextHook({
            cwd: tmpDir,
            getConfig: () => undefined,
        });
        const env = buildEnvContextHook();
        const reply = buildReplyLanguageContextHook(() => undefined); // returns undefined
        const thinking = buildStripThinkingContextHook(() => "medium"); // returns undefined

        const original = [makeStackUserMessage("msg")];
        const final = emitContextHooks([instr, env, reply, thinking], original);
        const text = allStackText(final);

        assert.ok(text.includes("<instructions"), "instructions survives reply → undefined");
        assert.ok(
            text.includes('<env as_of="'),
            "env survives even though reply returned undefined",
        );
        assert.ok(!text.includes("<reply_language"), "reply_language should NOT appear");
    });

    it("all hooks return undefined → transformContext fallback keeps mutations", () => {
        const env = buildEnvContextHook();
        const reply = buildReplyLanguageContextHook(() => undefined);
        const thinking = buildStripThinkingContextHook(() => "medium");
        const safetyNet = (event: { messages: AgentMessage[] }) => ({
            messages: event.messages,
        });

        const original = [makeStackUserMessage("msg")];
        const final = emitContextHooks([env, reply, thinking, safetyNet], original);
        const text = allStackText(final);

        assert.ok(
            text.includes('<env as_of="'),
            "env mutation survives even though earlier hooks returned undefined",
        );
    });
});

function emptyPrep(): CompactionPreparation {
    return {
        messagesToSummarize: [],
        turnPrefixMessages: [],
        retainedTail: [],
        isSplitTurn: false,
        tokensBefore: 0,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 4096, keepRecentTokens: 1000 },
    } as CompactionPreparation;
}

function pinnedPrep(): CompactionPreparation {
    const prep = emptyPrep();
    prep.messagesToSummarize = [
        {
            role: "user",
            content: '<skill_body name="rule">NEVER touch prod</skill_body>\nplease continue',
            timestamp: 0,
        } as never,
    ];
    return prep;
}

function stubCompact(captured: {
    customInstructions?: string;
}): typeof import("../../src/runtime/pi/values.ts").compact {
    return (async (_prep, _models, _model, customInstructions) => {
        captured.customInstructions = customInstructions;
        const value: CompactResult = {
            summary: "seven-section",
            tokensBefore: 0,
            retainedTail: [],
            details: { readFiles: [], modifiedFiles: [] },
        };
        return Result.ok(value);
    }) as typeof import("../../src/runtime/pi/values.ts").compact;
}

function hookFor(compact: typeof import("../../src/runtime/pi/values.ts").compact) {
    return buildPinAwareCompactHook({
        models: {} as Models,
        getModel: async () => ({ id: "m" }) as Model<never>,
        getRetryPolicy: async () => ({}) as never,
        compact,
    });
}

describe("buildPinAwareCompactHook customInstructions", () => {
    it("forwards caller instructions unchanged when nothing is pinned", async () => {
        const captured: { customInstructions?: string } = {};
        const hook = hookFor(stubCompact(captured));
        const result = await hook({
            preparation: emptyPrep(),
            customInstructions: "be terse",
        });
        assert.ok(result?.compaction);
        assert.equal(captured.customInstructions, "be terse");
    });

    it("uses the pin directive alone when auto-compact has no caller text", async () => {
        const captured: { customInstructions?: string } = {};
        const hook = hookFor(stubCompact(captured));
        await hook({ preparation: pinnedPrep() });
        const expected = buildPinnedDirective(["skill_body"]);
        assert.equal(captured.customInstructions, expected);
    });

    it("keeps caller instructions ahead of the pin directive", async () => {
        const captured: { customInstructions?: string } = {};
        const hook = hookFor(stubCompact(captured));
        await hook({
            preparation: pinnedPrep(),
            customInstructions: "be terse",
        });
        assert.ok(captured.customInstructions?.startsWith("be terse"));
        assert.ok(captured.customInstructions?.includes("skill_body"));
    });

    it("appends the pin tail after the pi summary", async () => {
        const captured: { customInstructions?: string } = {};
        const hook = hookFor(stubCompact(captured));
        const result = await hook({ preparation: pinnedPrep() });
        assert.ok(result?.compaction);
        assert.ok(result.compaction.summary.startsWith("seven-section"));
        assert.match(result.compaction.summary, /PINNED \(verbatim/);
        assert.match(result.compaction.summary, /NEVER touch prod/);
    });

    it("declines when the lane has no model", async () => {
        const hook = buildPinAwareCompactHook({
            models: {} as Models,
            getModel: async () => undefined,
            getRetryPolicy: async () => ({}) as never,
            compact: stubCompact({}),
        });
        assert.equal(await hook({ preparation: pinnedPrep() }), undefined);
    });
});

function makeImUserMessage(text: string): AgentMessage {
    return {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
    };
}

type HookResult = { messages: AgentMessage[] };

/** Narrow a hook result to a non-undefined return (lint: no non-null assertions). */
function expectInjected(result: HookResult | undefined): HookResult {
    if (!result) throw new Error("expected hook to inject <im_channel>");
    return result;
}

function messageAt(messages: AgentMessage[], index: number): AgentMessage {
    const msg = messages[index];
    if (!msg) throw new Error(`expected message at index ${index}`);
    return msg;
}

function imTextOf(msg: AgentMessage): string {
    const content = (msg as { content: { type: "text"; text: string }[] }).content;
    return content[0].text;
}

describe("buildImChannelContextHook", () => {
    it("appends an <im_channel> tag with type + channel_id to the tail", () => {
        const hook = buildImChannelContextHook(() => ({
            type: "wechat",
            channelId: "wechat-work",
        }));
        const event = { messages: [makeImUserMessage("hello")] };
        const result = expectInjected(hook(event));

        assert.equal(result.messages.length, 2);
        assert.equal(result.messages[1], event.messages[1], "tail-append, original first");
        const text = imTextOf(messageAt(result.messages, 1));
        assert.match(text, /^<im_channel type="wechat" channel_id="wechat-work">/);
        assert.match(text, /type: wechat/);
        assert.match(text, /channel_id: wechat-work/);
        assert.match(text, /<\/im_channel>$/);
    });

    it("returns undefined (no mutation) when the getter yields undefined", () => {
        const hook = buildImChannelContextHook(() => undefined);
        const original = [makeImUserMessage("hello")];
        const event = { messages: original };
        const result = hook(event);

        assert.equal(result, undefined);
        assert.equal(event.messages, original);
        assert.equal(event.messages.length, 1);
    });

    it("mutates event.messages in place and returns the same reference", () => {
        const hook = buildImChannelContextHook(() => ({
            type: "feishu",
            channelId: "feishu-team",
        }));
        const event = { messages: [makeImUserMessage("hi")] };
        const result = expectInjected(hook(event));

        assert.equal(result.messages, event.messages, "same array reference (last-writer-wins)");
    });

    it("reads the getter on every call (dynamic, not a construction snapshot)", () => {
        let current = { type: "wechat", channelId: "wechat-a" };
        const hook = buildImChannelContextHook(() => current);

        const first = expectInjected(hook({ messages: [makeImUserMessage("m1")] }));
        assert.match(imTextOf(messageAt(first.messages, 1)), /channel_id: wechat-a/);

        current = { type: "feishu", channelId: "feishu-b" };
        const second = expectInjected(hook({ messages: [makeImUserMessage("m2")] }));
        assert.match(imTextOf(messageAt(second.messages, 1)), /channel_id: feishu-b/);
        assert.match(imTextOf(messageAt(second.messages, 1)), /type: feishu/);
    });

    it("never exposes peer/chat ids or credentials even when the source has them", () => {
        // The upstream route fixture may carry peerId/chatId; the hook only
        // consumes the safe DTO, so they must not appear in the tag.
        const hook = buildImChannelContextHook(() => ({
            type: "mock",
            channelId: "mock-1",
        }));
        const event = { messages: [makeImUserMessage("hi")] };
        const result = expectInjected(hook(event));
        const text = imTextOf(messageAt(result.messages, 1));
        assert.doesNotMatch(text, /peer_id/);
        assert.doesNotMatch(text, /chat_id/);
        assert.doesNotMatch(text, /credential|token|secret/i);
    });
});

function envTextOf(messages: AgentMessage[]): string {
    return messages
        .map((m) => {
            const c = (m as { content?: unknown }).content;
            if (Array.isArray(c))
                return (c as Array<{ text?: string }>).map((b) => b.text).join("");
            return String(c ?? "");
        })
        .join("\n");
}

describe("buildEnvContextHook", () => {
    it("appends an <env as_of> tag with no cwd/shell and no duplicated local_time body", () => {
        const hook = buildEnvContextHook();
        const event = { messages: [] as AgentMessage[] };
        const result = hook(event);
        const text = envTextOf(result.messages);
        assert.match(text, /<env as_of="/);
        assert.ok(!text.includes("local_time:"), "time lives only on as_of");
        assert.ok(!text.includes("cwd:"), "cwd moved to the static system prompt");
        assert.ok(!text.includes("shell:"), "shell moved to the static system prompt");
    });

    it("as_of carries the weekday so relative dates resolve", () => {
        const hook = buildEnvContextHook();
        const text = envTextOf(hook({ messages: [] as AgentMessage[] }).messages);
        const stamp = /as_of="([^"]+)"/.exec(text)?.[1];
        assert.ok(stamp, "as_of must render a value");

        // Locale-agnostic: assert the weekday option took effect by diffing the
        // same instant formatted with and without it. Matching literal weekday
        // names would pin the test to the host ICU locale (and to the weekday
        // being a prefix, which is false for e.g. zh-CN).
        const opts: Intl.DateTimeFormatOptions = {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        };
        const now = new Date();
        const withoutWeekday = now.toLocaleString(undefined, opts);
        const withWeekday = now.toLocaleString(undefined, { ...opts, weekday: "long" });
        assert.notEqual(withWeekday, withoutWeekday, "weekday must add content in this locale");
        assert.ok(
            stamp.length > withoutWeekday.length,
            `stamp must be longer than the weekday-less form (got "${stamp}")`,
        );
    });

    it("pushes to the tail (stable prefix untouched)", () => {
        const hook = buildEnvContextHook();
        const first: AgentMessage = {
            role: "user",
            content: [{ type: "text", text: "first" }],
            timestamp: 0,
        };
        const event = { messages: [first] };
        const result = hook(event);
        assert.equal(result.messages.length, 2);
        assert.ok(envTextOf([result.messages[0]]).includes("first"), "original stays at head");
        assert.ok(envTextOf([result.messages[1]]).includes('<env as_of="'), "env goes to the tail");
    });
});

function instrUserMsg(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function instrTextOf(msg: AgentMessage): string {
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
        const original = instrUserMsg("hello");
        const result = hook({ messages: [original] });
        assert.ok(result);
        const injected = result.messages ?? [];
        assert.equal(injected[0], original);
        assert.ok(instrTextOf(injected[1] as AgentMessage).includes("<instructions"));
        assert.ok(instrTextOf(injected[1] as AgentMessage).includes("Be concise."));
    });

    it("does not re-append when the same block is already in the window", () => {
        const hook = buildInstructionsContextHook({ cwd: dir, getConfig: () => undefined });
        const first = hook({ messages: [instrUserMsg("hello")] });
        assert.ok(first);
        const firstMessages = first.messages ?? [];
        const second = hook({ messages: firstMessages });
        assert.equal(second, undefined);
        assert.equal(
            firstMessages.filter((m) => instrTextOf(m).includes("<instructions")).length,
            1,
        );
    });

    it("does not re-append when the same block is nested inside another user message", () => {
        const hook = buildInstructionsContextHook({ cwd: dir, getConfig: () => undefined });
        const first = hook({ messages: [instrUserMsg("hello")] });
        assert.ok(first);
        const tag = instrTextOf((first.messages ?? [])[1] as AgentMessage);
        assert.ok(tag.includes("<instructions"));
        // Compaction / pin-aware compact may concatenate the tag into a later
        // user message. Dedup must still recognise the inner block.
        const wrapped = instrUserMsg(`preamble\n${tag}\ntrailer`);
        const second = hook({ messages: [instrUserMsg("next"), wrapped] });
        assert.equal(second, undefined);
    });
});

function makeReplyUserMessage(text: string): AgentMessage {
    return {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
    };
}

describe("buildReplyLanguageContextHook", () => {
    function firstText(msg: AgentMessage): string {
        assert.equal(msg.role, "user", "expected user message");
        const content = (msg as { content: { type: "text"; text: string }[] }).content;
        return content[0].text;
    }

    it("emits a <reply_language> tag when the getter returns a locale", () => {
        const hook = buildReplyLanguageContextHook(() => "zh");
        const event = { messages: [makeReplyUserMessage("hello")] };
        const result = hook(event);

        assert.ok(result);
        assert.equal(result.messages.length, 2);
        const tagMsg = result.messages[1];
        assert.ok(tagMsg);
        const text = firstText(tagMsg);
        assert.match(text, /^<reply_language locale="zh">/);
        assert.match(text, /Always reply in Chinese/);
        assert.match(text, /<\/reply_language>$/);
    });

    it("passes messages through unchanged when the getter returns undefined", () => {
        const hook = buildReplyLanguageContextHook(() => undefined);
        const event = { messages: [makeReplyUserMessage("hi"), makeReplyUserMessage("there")] };
        const result = hook(event);
        assert.equal(result, undefined);
    });

    it("reads the getter on every call (per-turn dynamic)", () => {
        let current: "zh" | "en" | undefined = "zh";
        const hook = buildReplyLanguageContextHook(() => current);

        const resultZh = hook({ messages: [makeReplyUserMessage("x")] });
        assert.ok(resultZh);
        const tagZh = resultZh.messages[1];
        assert.ok(tagZh);
        assert.match(firstText(tagZh), /Chinese/);

        current = "en";
        const resultEn = hook({ messages: [makeReplyUserMessage("x")] });
        assert.ok(resultEn);
        const tagEn = resultEn.messages[1];
        assert.ok(tagEn);
        assert.match(firstText(tagEn), /English/);
    });

    it("places the tag AFTER the original messages AND mutates the input array in place", () => {
        const hook = buildReplyLanguageContextHook(() => "en");
        const userMsg = makeReplyUserMessage("user msg");
        const original = [userMsg];
        const result = hook({ messages: original });
        assert.ok(result);
        // Append, not unshift: messages[0] must stay the real user turn so the
        // prompt-cache prefix is stable. Mutation is still in-place.
        assert.equal(result.messages, original, "result.messages must be the same reference");
        assert.equal(original.length, 2, "input array must be mutated to length 2");
        assert.equal(original[0], userMsg);
    });
});
