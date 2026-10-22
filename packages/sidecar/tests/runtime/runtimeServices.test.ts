/**
 * Runtime services: context usage, title summarization, prompt-cache
 * fingerprinting, and the tool-result cap.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { ContextInfoService } from "../../src/runtime/compaction/contextInfoService.ts";
import {
    fingerprintPayload,
    MAX_TRACKED_FINGERPRINT_KEYS,
    recordPromptCacheFingerprint,
    resetPromptCacheFingerprints,
} from "../../src/runtime/harness/promptCacheFingerprint.ts";
import { capToolResult } from "../../src/runtime/harness/toolResultCap.ts";
import type {
    AgentLane,
    AgentMessage,
    Api,
    Entry,
    Model,
    Models,
    Session,
    TextContent,
} from "../../src/runtime/pi/types.ts";
import { sidecarVersion } from "../../src/runtime/runtimeResources.ts";
import { MAIN_BRANCH } from "../../src/runtime/session/sessionBranch.ts";
import { cleanTitle, TitleSummarizer } from "../../src/runtime/session/titleSummarizer.ts";

describe("contextInfoService", () => {
    interface UsageParts {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        /** Omit to simulate a partial usage record (missing cost.total → skipped). */
        withCostTotal?: boolean;
    }

    /** Build an assistant `message` entry carrying a usage record. */
    function assistantEntry(u: UsageParts): Entry {
        const usage: Record<string, unknown> = {
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
        };
        if (u.withCostTotal !== false) usage.cost = { total: 0 };
        return {
            type: "message",
            message: { role: "assistant", usage },
        } as unknown as Entry;
    }

    /** Build a compaction entry carrying a usage record (cacheRetention: none). */
    function compactionEntry(u: UsageParts, timestamp?: number): Entry {
        return {
            type: "compaction",
            timestamp,
            summary: "",
            retainedTail: [],
            tokensBefore: 0,
            fromHook: false,
            usage: {
                input: u.input,
                output: u.output,
                cacheRead: u.cacheRead,
                cacheWrite: u.cacheWrite,
                cost: { total: 0 },
            },
        } as unknown as Entry;
    }

    /**
     * Minimal Session stub — only the methods ContextInfoService uses.
     *
     * pi 0.85 split "branch walk" (cache aggregate is over the *whole* log,
     * including abandoned branches) from "current branch" (compaction timestamp
     * lives on the leaf branch only). The stub exposes both surfaces.
     */
    function makeSessionStub(opts: {
        entries?: ReadonlyArray<Entry> | Error;
        branchEntries?: ReadonlyArray<Entry>;
    }): Session {
        return {
            findEntries: async (_query: unknown, _context: unknown) => {
                if (opts.entries instanceof Error) throw opts.entries;
                return [...(opts.entries ?? [])];
            },
            branch: async (name: string, _context: unknown) => {
                if (name !== MAIN_BRANCH) return undefined;
                return {
                    findEntry: async (query: { type?: string; order?: string }) => {
                        const branch = opts.branchEntries ?? [];
                        const list =
                            query?.order === "newestFirst" ? [...branch].reverse() : branch;
                        return list.find((e) => e.type === query?.type);
                    },
                    findEntries: async (_query: unknown) => opts.branchEntries ?? [],
                };
            },
        } as unknown as Session;
    }

    /** Minimal lane stub — only getModel(). */
    function makeLaneStub(model: Model<Api> | undefined): AgentLane {
        return {
            getModel: async () => model,
        } as unknown as AgentLane;
    }

    const fakeModel: Model<Api> = {
        id: "claude-test",
        provider: "anthropic",
        contextWindow: 200_000,
    } as unknown as Model<Api>;

    describe("ContextInfoService", () => {
        it("fresh session omits cache fields", async () => {
            const svc = new ContextInfoService({
                session: makeSessionStub({ entries: [] }),
                lane: makeLaneStub(fakeModel),
            });
            const result = await svc.getContextInfo();
            assert.equal(result.cacheRead, undefined);
            assert.equal(result.cacheHitRatio, undefined);
            assert.equal(result.usedTokens, 0);
            assert.equal(result.ratio, 0);
            assert.equal(result.contextWindow, 200_000);
        });

        it("input but zero cache hits → wires cacheRead:0 + ratio:0", async () => {
            const svc = new ContextInfoService({
                session: makeSessionStub({
                    entries: [
                        assistantEntry({
                            input: 50_000,
                            output: 1000,
                            cacheRead: 0,
                            cacheWrite: 0,
                        }),
                    ],
                }),
                lane: makeLaneStub(fakeModel),
            });
            const result = await svc.getContextInfo();
            // cacheRead=0 + cacheHitRatio=0 distinguishes "session has LLM traffic
            // but no cache hits" from `undefined` ("fresh session, no calls yet").
            assert.equal(result.cacheRead, 0);
            assert.equal(result.cacheHitRatio, 0);
            assert.equal(result.cacheHitRatioTurns, 0);
        });

        it("hit rate = ΣcacheRead / Σ(input + cacheRead); cacheWrite + output excluded", async () => {
            // input=10k, cacheRead=30k, cacheWrite=99k, output=60k.
            // Hit rate (B) = 30 / (10 + 30) = 0.75.
            // cacheWrite (99k) and output (60k) must NOT be in the denominator.
            const svc = new ContextInfoService({
                session: makeSessionStub({
                    entries: [
                        assistantEntry({
                            input: 10_000,
                            output: 60_000,
                            cacheRead: 30_000,
                            cacheWrite: 99_000,
                        }),
                    ],
                }),
                lane: makeLaneStub(fakeModel),
            });
            const result = await svc.getContextInfo();
            assert.equal(result.cacheRead, 30_000);
            assert.ok(
                Math.abs((result.cacheHitRatio ?? 0) - 0.75) < 1e-9,
                `expected 0.75, got ${result.cacheHitRatio}`,
            );
            assert.equal(result.cacheHitRatioTurns, result.cacheHitRatio);
        });

        it("input=0 (all-cached prefix) → hit rate 100%", async () => {
            // Mirrors the real session that prompted the switch to formula B:
            // every input token was a cache hit, so hit rate must read 100%,
            // not be dragged down by the one-time cacheWrite.
            const svc = new ContextInfoService({
                session: makeSessionStub({
                    entries: [
                        assistantEntry({ input: 0, output: 68, cacheRead: 6585, cacheWrite: 1911 }),
                        assistantEntry({
                            input: 0,
                            output: 1150,
                            cacheRead: 8420,
                            cacheWrite: 7969,
                        }),
                    ],
                }),
                lane: makeLaneStub(fakeModel),
            });
            const result = await svc.getContextInfo();
            assert.equal(result.cacheRead, 15_005);
            assert.equal(result.cacheHitRatio, 1);
        });

        it("compaction entry (cacheRead=0) drags hit rate down only via its own input", async () => {
            // A normal turn with a strong hit, then a compaction whose input is
            // fresh (cacheRead=0, cacheRetention:none). The compaction's input
            // enters the denominator; its large output does not.
            const svc = new ContextInfoService({
                session: makeSessionStub({
                    entries: [
                        assistantEntry({
                            input: 0,
                            output: 500,
                            cacheRead: 40_000,
                            cacheWrite: 5000,
                        }),
                        compactionEntry({
                            input: 20_000,
                            output: 100_000,
                            cacheRead: 0,
                            cacheWrite: 0,
                        }),
                    ],
                }),
                lane: makeLaneStub(fakeModel),
            });
            const result = await svc.getContextInfo();
            assert.equal(result.cacheRead, 40_000);
            // 40k / (40k + 20k) = 0.666… — the 100k output does NOT appear.
            assert.ok(
                Math.abs((result.cacheHitRatio ?? 0) - 40_000 / 60_000) < 1e-9,
                `expected 0.667, got ${result.cacheHitRatio}`,
            );
            // Turns-only excludes the compaction row, so the assistant turn is a
            // perfect hit.
            assert.equal(result.cacheHitRatioTurns, 1);
        });

        it("a compaction-only log omits cacheHitRatioTurns (summary is not a turn)", async () => {
            const svc = new ContextInfoService({
                session: makeSessionStub({
                    entries: [
                        compactionEntry({
                            input: 20_000,
                            output: 8_000,
                            cacheRead: 0,
                            cacheWrite: 0,
                        }),
                    ],
                }),
                lane: makeLaneStub(fakeModel),
            });
            const result = await svc.getContextInfo();
            assert.equal(result.cacheRead, 0);
            assert.equal(result.cacheHitRatio, 0);
            assert.equal(result.cacheHitRatioTurns, undefined);
        });

        it("partial usage records are skipped (missing cost.total)", async () => {
            const svc = new ContextInfoService({
                session: makeSessionStub({
                    entries: [
                        assistantEntry({
                            input: 10_000,
                            output: 100,
                            cacheRead: 10_000,
                            cacheWrite: 0,
                        }),
                        // This one is missing cost.total → must be skipped entirely.
                        assistantEntry({
                            input: 999_999,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            withCostTotal: false,
                        }),
                    ],
                }),
                lane: makeLaneStub(fakeModel),
            });
            const result = await svc.getContextInfo();
            // Only the first entry counts: 10k / (10k + 10k) = 0.5.
            assert.equal(result.cacheRead, 10_000);
            assert.equal(result.cacheHitRatio, 0.5);
        });

        it("findEntries throws → cache fields omitted, other fields still populated", async () => {
            const svc = new ContextInfoService({
                session: makeSessionStub({ entries: new Error("disk gone") }),
                lane: makeLaneStub(fakeModel),
            });
            const result = await svc.getContextInfo();
            assert.equal(result.cacheRead, undefined);
            assert.equal(result.cacheHitRatio, undefined);
            assert.equal(result.modelId, "claude-test");
        });

        it("branch.findEntry throws → lastCompactionAt omitted, cache fields still wired", async () => {
            const session = {
                findEntries: async () => [
                    assistantEntry({ input: 200, output: 10, cacheRead: 100, cacheWrite: 0 }),
                ],
                branch: async () => ({
                    findEntry: async () => {
                        throw new Error("branch failed");
                    },
                    findEntries: async () => [],
                }),
            } as unknown as Session;
            const svc = new ContextInfoService({
                session,
                lane: makeLaneStub(fakeModel),
            });
            const result = await svc.getContextInfo();
            assert.equal(result.lastCompactionAt, undefined);
            assert.equal(result.cacheRead, 100);
            assert.ok(result.cacheHitRatio !== undefined);
        });

        it("lastCompactionAt from the most recent compaction entry on the leaf branch", async () => {
            const entries: Entry[] = [
                { type: "message" } as unknown as Entry,
                {
                    type: "compaction",
                    timestamp: 0,
                    summary: "",
                    retainedTail: [],
                    tokensBefore: 0,
                    fromHook: false,
                } as unknown as Entry,
                { type: "message" } as unknown as Entry,
                {
                    type: "compaction",
                    timestamp: 1,
                    summary: "",
                    retainedTail: [],
                    tokensBefore: 0,
                    fromHook: false,
                } as unknown as Entry,
            ];
            const svc = new ContextInfoService({
                session: makeSessionStub({ branchEntries: entries }),
                lane: makeLaneStub(fakeModel),
            });
            const result = await svc.getContextInfo();
            // The branch stub stringifies entry.timestamp; numeric 0 becomes "0" and
            // numeric 1 becomes "1". The "newest" one is the larger number — the
            // contract is "most recent", which is what stringification from a
            // monotonic epoch guarantees.
            assert.equal(result.lastCompactionAt, "1");
        });

        it("lane.getModel() returns undefined → empty model fields, no crash", async () => {
            const svc = new ContextInfoService({
                session: makeSessionStub({
                    entries: [
                        assistantEntry({ input: 200, output: 10, cacheRead: 100, cacheWrite: 0 }),
                    ],
                }),
                lane: makeLaneStub(undefined),
            });
            const result = await svc.getContextInfo();
            assert.equal(result.modelId, "");
            assert.equal(result.provider, "");
            assert.equal(result.contextWindow, 0);
            assert.equal(result.ratio, 0);
            // cache fields still wire — they don't depend on the model.
            assert.equal(result.cacheRead, 100);
            assert.ok(result.cacheHitRatio !== undefined);
        });

        it("buildBranchContext throws → exception propagates", async () => {
            // buildBranchContext reads session.branch(...).findEntries(...). Stub a
            // branch whose findEntries throws to verify getContextInfo does not
            // swallow it. (The original test named buildContext — 0.85 renamed it.)
            const session = {
                branch: async () => ({
                    findEntries: async () => {
                        throw new Error("corrupt session");
                    },
                }),
                findEntries: async () => [],
            } as unknown as Session;
            const svc = new ContextInfoService({
                session,
                lane: makeLaneStub(fakeModel),
            });
            await assert.rejects(() => svc.getContextInfo(), /corrupt session/);
        });

        // Touch `harnessContext` so lint does not flag the imported-but-unused
        // symbol in branches that drop the import (e.g. when reading via harness
        // would be required). It is imported here only because the surrounding
        // stub contract intentionally mirrors pi's Context threading.
        void harnessContext;
    });
});

describe("titleSummarizer", () => {
    describe("cleanTitle", () => {
        it("passes through a clean short title unchanged", () => {
            assert.equal(cleanTitle("Fix login bug"), "Fix login bug");
        });

        it("strips surrounding double quotes", () => {
            assert.equal(cleanTitle('"Fix login bug"'), "Fix login bug");
        });

        it("strips surrounding markdown emphasis", () => {
            assert.equal(cleanTitle("**Fix login bug**"), "Fix login bug");
        });

        it("collapses internal whitespace/newlines", () => {
            assert.equal(cleanTitle("Fix   login\n\nbug"), "Fix login bug");
        });

        it("trims trailing punctuation the model sometimes adds", () => {
            assert.equal(cleanTitle("Fix login bug."), "Fix login bug");
            assert.equal(cleanTitle("修复登录问题。"), "修复登录问题");
        });

        it("clamps to 20 grapheme clusters, not UTF-16 code units", () => {
            // One `Array.from(stripped).slice(0, 20)` serves all three alphabets.
            assert.equal(Array.from(cleanTitle("a".repeat(30))).length, 20);
            assert.equal(Array.from(cleanTitle("修".repeat(25))).length, 20);
            // 21 emoji graphemes (each a surrogate pair) — clamped to 20 must drop
            // whole graphemes, never leave a lone high/low surrogate dangling.
            const out = cleanTitle("😀".repeat(21));
            assert.equal(Array.from(out).length, 20);
            // A dangling surrogate would make this string invalid / mismatched
            // length under a code-point re-split; assert round-trip stability.
            assert.equal(Array.from(out).join(""), out);
        });

        it("returns empty string for input that is only quotes/whitespace", () => {
            assert.equal(cleanTitle('   "  "   '), "");
        });
    });

    function fakeMessage(text: string): AgentMessage {
        return {
            role: "user",
            content: text,
            timestamp: Date.now(),
        } as unknown as AgentMessage;
    }

    // Long enough to clear MIN_TOKEN_THRESHOLD (30 tokens ~= 120 chars).
    const LONG_CONVERSATION =
        "user: " + "please help me debug this login redirect issue ".repeat(6);

    describe("TitleSummarizer.onRunEnd", () => {
        it("calls setSummaryTitle with the cleaned model output", async () => {
            const fakeModel = { provider: "test", id: "m" } as unknown as Model<Api>;
            const fakeModels = {
                completeSimple: async () => ({
                    role: "assistant",
                    content: [{ type: "text", text: '"Fix login bug."' } satisfies TextContent],
                }),
            } as unknown as Models;

            let captured: { sessionId: string; name: string } | undefined;
            const setSummaryTitle = async (sessionId: string, name: string) => {
                captured = { sessionId, name };
                return true;
            };

            const sessionId = asSessionId("s-1");
            const summarizer = new TitleSummarizer(
                fakeModels,
                fakeModel,
                sessionId,
                setSummaryTitle,
            );
            await summarizer.onRunEnd([fakeMessage(LONG_CONVERSATION)]);

            assert.deepEqual(captured, { sessionId: "s-1", name: "Fix login bug" });
        });

        it("skips the LLM call entirely below the token threshold", async () => {
            let called = false;
            const fakeModel = { provider: "test", id: "m" } as unknown as Model<Api>;
            const fakeModels = {
                completeSimple: async () => {
                    called = true;
                    return { role: "assistant", content: [] };
                },
            } as unknown as Models;

            const summarizer = new TitleSummarizer(
                fakeModels,
                fakeModel,
                asSessionId("s-1"),
                async () => true,
            );
            await summarizer.onRunEnd([fakeMessage("hi")]);

            assert.equal(called, false);
        });

        it("does not call setSummaryTitle when the model returns empty text", async () => {
            let called = false;
            const fakeModel = { provider: "test", id: "m" } as unknown as Model<Api>;
            const fakeModels = {
                completeSimple: async () => ({ role: "assistant", content: [] }),
            } as unknown as Models;

            const summarizer = new TitleSummarizer(
                fakeModels,
                fakeModel,
                asSessionId("s-1"),
                async () => {
                    called = true;
                    return true;
                },
            );
            await summarizer.onRunEnd([fakeMessage(LONG_CONVERSATION)]);

            assert.equal(called, false);
        });

        it("never throws when the LLM call rejects — fire-and-forget", async () => {
            const fakeModel = { provider: "test", id: "m" } as unknown as Model<Api>;
            const fakeModels = {
                completeSimple: async () => {
                    throw new Error("provider unavailable");
                },
            } as unknown as Models;

            const summarizer = new TitleSummarizer(
                fakeModels,
                fakeModel,
                asSessionId("s-1"),
                async () => true,
            );
            await assert.doesNotReject(() => summarizer.onRunEnd([fakeMessage(LONG_CONVERSATION)]));
        });

        it("never throws when setSummaryTitle itself rejects", async () => {
            const fakeModel = { provider: "test", id: "m" } as unknown as Model<Api>;
            const fakeModels = {
                completeSimple: async () => ({
                    role: "assistant",
                    content: [{ type: "text", text: "Fix login bug" } satisfies TextContent],
                }),
            } as unknown as Models;

            const summarizer = new TitleSummarizer(
                fakeModels,
                fakeModel,
                asSessionId("s-1"),
                async () => {
                    throw new Error("session closed mid-write");
                },
            );
            await assert.doesNotReject(() => summarizer.onRunEnd([fakeMessage(LONG_CONVERSATION)]));
        });
    });

    /**
     * `TitleSummarizer.onRunEnd` — taco headers on the summarization LLM call.
     * Same regression this pins for MemoryExtractorImpl: this call sits OUTSIDE
     * the harness streamOptions (which is where `withTacoUserAgent` attaches the
     * taco tag for main conversation turns), so a missing header here would
     * surface at the provider as the bundled sidecar's mangled default user agent.
     */
    describe("TitleSummarizer — taco headers on the summarization LLM call", () => {
        it("forwards tacoRequestHeaders to models.completeSimple", async () => {
            const version = sidecarVersion();
            let capturedOptions: { headers?: Record<string, string> } | undefined;

            const fakeModel = { provider: "test", id: "m" } as unknown as Model<Api>;
            const fakeModels = {
                completeSimple: async (
                    _model: Model<Api>,
                    _context: unknown,
                    options?: { headers?: Record<string, string> },
                ) => {
                    capturedOptions = options;
                    return {
                        role: "assistant",
                        content: [{ type: "text", text: "Fix login bug" } satisfies TextContent],
                    };
                },
            } as unknown as Models;

            const summarizer = new TitleSummarizer(
                fakeModels,
                fakeModel,
                asSessionId("s-1"),
                async () => true,
            );
            await summarizer.onRunEnd([fakeMessage(LONG_CONVERSATION)]);

            assert.ok(capturedOptions, "completeSimple should have been called");
            assert.ok(capturedOptions?.headers?.["user-agent"]?.includes(version));
        });
    });
});

describe("promptCacheFingerprint", () => {
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
});

describe("toolResultCap", () => {
    type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

    function textOf(parts: readonly Part[] | undefined): string {
        return (parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
    }

    describe("capToolResult", () => {
        it("leaves a result under the cap untouched", () => {
            assert.equal(
                capToolResult({ content: [{ type: "text", text: "ok" }] }, 100),
                undefined,
            );
        });

        it("keeps head and tail of an oversized result within the cap", () => {
            const text = `HEAD${"x".repeat(50_000)}TAIL`;
            const patch = capToolResult({ content: [{ type: "text", text }] }, 10_000);
            const out = textOf(patch?.content as Part[]);
            assert.ok(out.startsWith("HEAD"));
            assert.ok(out.endsWith("TAIL"));
            assert.match(out, /chars omitted/);
            // The marker adds a short fixed overhead on top of the kept budget.
            assert.ok(out.length < 10_300, `got ${out.length}`);
        });

        it("keeps a small header part whole while clipping the large body", () => {
            const header = "exit code: 1";
            const body = "y".repeat(200_000);
            const patch = capToolResult(
                {
                    content: [
                        { type: "text", text: header },
                        { type: "text", text: body },
                    ],
                },
                10_000,
            );
            const parts = patch?.content as Part[];
            assert.equal(parts[0].type === "text" && parts[0].text, header);
            assert.ok(textOf(parts).length < 10_500);
        });

        it("passes image parts through", () => {
            const image: Part = { type: "image", data: "AAAA", mimeType: "image/png" };
            const patch = capToolResult(
                { content: [image, { type: "text", text: "z".repeat(5_000) }] },
                1_000,
            );
            assert.deepEqual((patch?.content as Part[])[0], image);
        });
    });

    describe("wireHarnessHooks — tool result cap", () => {
        it("registers the cap after extension tool_result hooks", async () => {
            const { createModels } = await import("@earendil-works/pi-ai/compat");
            const { wireHarnessHooks } = await import("../../src/runtime/harness/hookWiring.ts");
            type AfterTool = (event: Record<string, unknown>) => Promise<unknown>;
            const afterTool: AfterTool[] = [];
            const harness = {
                hooks: {
                    on(type: string, handler: AfterTool) {
                        if (type === "after_tool") afterTool.push(handler);
                        return () => {};
                    },
                },
            };
            // An extension that inflates the result: the cap must still have the last word.
            const inflate = () => ({
                content: [{ type: "text" as const, text: "w".repeat(500_000) }],
            });
            await wireHarnessHooks(harness as never, {} as never, {
                cwd: "/tmp/ws",
                getThinkingLevel: () => "off",
                models: createModels(),
                extensionToolResultHooks: { builtins: [inflate], external: [] },
            });
            let current: Record<string, unknown> = {
                toolCallId: "t",
                toolName: "mcp__x",
                args: {},
                content: [{ type: "text", text: "small" }],
                isError: false,
            };
            for (const handler of afterTool) {
                const patch = (await handler(current)) as { content?: unknown } | undefined;
                if (patch?.content !== undefined) current = { ...current, content: patch.content };
            }
            assert.ok(textOf(current.content as Part[]).length < 101_000);
        });
    });
});
