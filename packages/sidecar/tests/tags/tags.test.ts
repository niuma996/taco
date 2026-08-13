/**
 * Tag system unit tests.
 *
 * Run with Node's built-in `node:test` runner through tsx:
 *
 *   pnpm --filter @taco-ai/sidecar test:tags
 *
 * No new dependencies — Node 22 ships `node:test` and `tsx` is already in
 * sidecar's devDependencies.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseAskUserContext, rehydrateAskUserDetails } from "../../src/tags/askUserRehydrate.ts";
import { tagWrap } from "../../src/tags/builder.ts";
import { detectFences, findBalancedTagsSkippingFences } from "../../src/tags/fenceAware.ts";
import { findBalancedTags } from "../../src/tags/parser.ts";
import {
    collectDropRanges,
    stripDropTagsFromMessages,
    stripDropTagsInText,
} from "../../src/tags/policy/dropPolicy.ts";
import { stripRanges } from "../../src/tags/policy/textRanges.ts";
import {
    isContentEmptyAfterVisibility,
    stripEphemeralTagWrappers,
    stripHiddenTagsInMarkdown,
} from "../../src/tags/policy/visibility.ts";
import { tagRegistry } from "../../src/tags/registry.ts";
import { TEST_DROP_TAG, TEST_EPHEMERAL_TAG } from "../_helpers/testTags.ts";

const lt = "<";
const gt = ">";
const fooOpen = `${lt}foo${gt}`;
const fooClose = `${lt}/foo${gt}`;

describe("findBalancedTags", () => {
    it("returns inner, attrs, range for a simple pair", () => {
        const text = `before ${fooOpen}body${fooClose} after`;
        const matches = findBalancedTags(text, "foo");
        assert.equal(matches.length, 1);
        const m = matches[0];
        assert.ok(m);
        assert.equal(m.inner, "body");
        assert.deepEqual(m.attrs, {});
        assert.equal(text.slice(m.range[0], m.range[1]), `${fooOpen}body${fooClose}`);
    });

    it("parses attribute values", () => {
        const text = `${lt}foo scope="user" path="/src"${gt}body${fooClose}`;
        const m = findBalancedTags(text, "foo")[0];
        assert.ok(m);
        assert.equal(m.attrs.scope, "user");
        assert.equal(m.attrs.path, "/src");
        assert.equal(m.inner, "body");
    });

    it("parses unquoted bare attributes", () => {
        const text = `${lt}foo flag${gt}b${fooClose}`;
        const m = findBalancedTags(text, "foo")[0];
        assert.ok(m);
        assert.equal(m.attrs.flag, "");
    });

    it("does not match prefix-only lookalikes", () => {
        // <requestFoo> must not be picked up by findBalancedTags(text, "request")
        const text = `${lt}requestFoo${gt}body${lt}/requestFoo${gt}`;
        assert.equal(findBalancedTags(text, "request").length, 0);
    });

    it("nests multiple separate pairs", () => {
        const text = `${fooOpen}A${fooClose} middle ${fooOpen}B${fooClose}`;
        const ms = findBalancedTags(text, "foo");
        assert.equal(ms.length, 2);
        assert.equal(ms[0]?.inner, "A");
        assert.equal(ms[1]?.inner, "B");
    });

    it("innermost-wins when same tag re-opens before close", () => {
        const text = `${fooOpen}A${fooOpen}B${fooClose}`;
        const ms = findBalancedTags(text, "foo");
        assert.equal(ms.length, 1);
        assert.equal(ms[0]?.inner, "B");
    });
});

describe("findBalancedTagsSkippingFences / detectFences", () => {
    it("finds tags outside code fences but ignores ones inside", () => {
        const text = [
            `${fooOpen}visible${fooClose}`,
            "```",
            `${fooOpen}inside${fooClose}`,
            "```",
        ].join("\n");
        const ms = findBalancedTagsSkippingFences(text, "foo");
        assert.equal(ms.length, 1);
        assert.equal(ms[0]?.inner, "visible");
    });

    it("detects tilde fences", () => {
        const text = "~~~ts\nfoo\n~~~";
        const fences = detectFences(text);
        assert.equal(fences.length, 1);
        const f = fences[0];
        assert.ok(f);
        assert.equal(text.slice(f[0], f[1]), text);
    });

    it("ignores fences that are not pure close markers", () => {
        const text = ["```", `${fooOpen}a${fooClose}`, "``` not closed yet"].join("\n");
        const fences = detectFences(text);
        assert.equal(fences.length, 0);
    });
});

describe("stripRanges", () => {
    it("removes covered ranges and rejoins cleanly", () => {
        // Original: a b X c d X Y e   (indices 0..7)
        // Strip [2,3) removes 'X' at idx 2; strip [4,6) removes 'd','X' at 4,5.
        // Remaining chars (in original order): a,b,c,Y,e → "abcYe".
        const text = "abXcdXYe";
        const out = stripRanges(text, [
            [2, 3],
            [4, 6],
        ]);
        assert.equal(out, "abcYe");
    });

    it("merges overlapping ranges", () => {
        const text = "0123456";
        const out = stripRanges(text, [
            [1, 4],
            [3, 5],
        ]);
        assert.equal(out, "056");
    });

    it("no-op on empty ranges", () => {
        assert.equal(stripRanges("abc", []), "abc");
    });
});

describe("tagWrap / escapeAttr", () => {
    it("wraps plain content", () => {
        assert.equal(
            tagWrap("instructions", "be concise"),
            `${lt}instructions${gt}\nbe concise\n${lt}/instructions${gt}`,
        );
    });
    it("escapes attribute values", () => {
        const out = tagWrap("instructions", "x", { path: '/a&b"c' });
        assert.ok(out.includes(`path="/a&amp;b&quot;c"`));
    });
});

describe("tagRegistry integrity", () => {
    it("registry loads without throwing", () => {
        assert.ok(tagRegistry);
    });
    it("contains expected well-known tags", () => {
        for (const name of ["instructions", "skill_body", "memory", "im_channel"]) {
            assert.ok(Object.hasOwn(tagRegistry, name), `missing ${name}`);
        }
    });

    it("im_channel is a drop + hidden system tag", () => {
        const spec = tagRegistry.im_channel;
        assert.ok(spec);
        assert.equal(spec.scope, "system");
        assert.equal(spec.compression.kind, "drop");
        assert.equal(spec.tuiVisibility, "hidden");
        assert.equal(spec.parser.kind, "xml-balanced");
    });
});

describe("drop policy", () => {
    const docsOpen = "<__test_drop__>";
    const docsClose = "</__test_drop__>";
    const dropNames = [TEST_DROP_TAG.name];

    it("collects ranges for xml-balanced drop tags", () => {
        const text = `prefix ${docsOpen}drop me${docsClose} suffix`;
        const ranges = collectDropRanges(text, dropNames);
        assert.equal(ranges.length, 1);
        const r = ranges[0];
        assert.ok(r);
        assert.equal(text.slice(r[0], r[1]), `${docsOpen}drop me${docsClose}`);
    });

    it("strips drop tags from a string", () => {
        const text = `keep ${docsOpen}drop me${docsClose} keep2`;
        assert.equal(stripDropTagsInText(text, dropNames), "keep  keep2");
    });

    it("strips drop tags from message array, preserves order and non-text messages", () => {
        const msgs = [
            { content: `A ${docsOpen}drop${docsClose} B`, role: "user" },
            { role: "user" }, // no content field
            { content: "untouched", role: "user" },
        ];
        const out = stripDropTagsFromMessages(msgs, dropNames);
        assert.equal(out.length, 3);
        assert.equal(out[0]?.content, "A  B");
        assert.equal(out[1], msgs[1]);
        assert.equal(out[2]?.content, "untouched");
    });
});

describe("visibility policy", () => {
    it("strips hidden tags", () => {
        const text = `${lt}instructions${gt}secret${lt}/instructions${gt} visible`;
        assert.equal(stripHiddenTagsInMarkdown(text), " visible");
    });

    it("leaves non-hidden tags alone", () => {
        const text = `${lt}request${gt}hi${lt}/request${gt}`;
        assert.equal(stripHiddenTagsInMarkdown(text), text);
    });

    it("strips ephemeral wrappers but keeps inner content", () => {
        const text = "<__test_ephemeral__>do the thing</__test_ephemeral__>";
        assert.equal(stripEphemeralTagWrappers(text, [TEST_EPHEMERAL_TAG.name]), "do the thing");
    });

    // Non-object blocks (null, primitives) are treated as non-empty so the message
    // is preserved instead of being hidden.
    it("keeps a message with a malformed (non-object) block instead of hiding it", () => {
        assert.equal(isContentEmptyAfterVisibility([null, { type: "text", text: "" }]), false);
        assert.equal(isContentEmptyAfterVisibility([42]), false);
    });

    it("hides a message where all blocks are empty", () => {
        assert.equal(isContentEmptyAfterVisibility([{ type: "text", text: "  " }]), true);
    });

    it("keeps a message with a non-empty text block", () => {
        assert.equal(isContentEmptyAfterVisibility([{ type: "text", text: "hello" }]), false);
    });

    it("keeps a message with an image block", () => {
        assert.equal(isContentEmptyAfterVisibility([{ type: "image" }]), false);
    });
});

describe("askUser context parsing", () => {
    it("extracts questions and answers from a balanced injection block", () => {
        const text = `${lt}ask_user_context${gt}The user has answered your askUser questions.\nquestions (JSON):\n${JSON.stringify([{ question: "q1", header: "h", options: [], multiSelect: false }])}\nanswers (JSON):\n${JSON.stringify({ q1: "answer-A" })}${lt}/ask_user_context${gt}`;
        const parsed = parseAskUserContext(text);
        assert.ok(parsed);
        assert.deepEqual(parsed?.answers, { q1: "answer-A" });
        assert.equal(parsed?.questions.length, 1);
    });

    it("returns null when tags are missing", () => {
        assert.equal(parseAskUserContext("plain text"), null);
        assert.equal(parseAskUserContext(`${lt}ask_user_context${gt}no close`), null);
    });

    it("returns null when JSON sections are malformed", () => {
        const text = `${lt}ask_user_context${gt}questions (JSON): not-json${lt}/ask_user_context${gt}`;
        assert.equal(parseAskUserContext(text), null);
    });

    it("tolerates nested braces in JSON answers", () => {
        const text = `${lt}ask_user_context${gt}questions (JSON):\n[]\nanswers (JSON):\n${JSON.stringify({ q1: { nested: { deep: 1 } } })}${lt}/ask_user_context${gt}`;
        const parsed = parseAskUserContext(text);
        assert.ok(parsed);
        assert.deepEqual(parsed?.answers, { q1: { nested: { deep: 1 } } });
    });
});

describe("rehydrateAskUserDetails", () => {
    function askUserToolResult(toolCallId: string, details?: unknown) {
        return {
            type: "message",
            message: {
                role: "toolResult",
                toolName: "askUser",
                toolCallId,
                content: [],
                details,
            },
        };
    }

    function userMessage(content: string) {
        return { type: "message", message: { role: "user", content } };
    }

    it("fills details.answers for a waiting askUser from the next injection", () => {
        const injectionText = `${lt}ask_user_context${gt}questions (JSON):\n${JSON.stringify([{ question: "q1", header: "h", options: [], multiSelect: false }])}\nanswers (JSON):\n${JSON.stringify({ q1: "A" })}${lt}/ask_user_context${gt}`;

        const entries = [
            askUserToolResult("tc-1", { questions: [], waiting: true }),
            userMessage(injectionText),
        ];
        const out = rehydrateAskUserDetails(entries);
        const toolResult = out[0] as {
            message: { details?: { answers?: unknown; answered?: boolean; waiting?: boolean } };
        };
        assert.deepEqual(toolResult.message.details?.answers, { q1: "A" });
        assert.equal(toolResult.message.details?.answered, true);
        assert.equal(toolResult.message.details?.waiting, false);
    });

    it("preserves already-populated answers from the realtime path", () => {
        const entries = [
            askUserToolResult("tc-1", { answers: { q1: "realtime" } }),
            userMessage(
                `${lt}ask_user_context${gt}answers (JSON): {"q1":"later"}${lt}/ask_user_context${gt}`,
            ),
        ];
        const out = rehydrateAskUserDetails(entries);
        const toolResult = out[0] as { message: { details?: { answers?: unknown } } };
        assert.deepEqual(toolResult.message.details?.answers, { q1: "realtime" });
    });

    it("skips non-askUser toolResults and non-matching user messages", () => {
        const entries = [
            { type: "message", message: { role: "toolResult", toolName: "read", toolCallId: "t" } },
            userMessage("regular user message"),
        ];
        const out = rehydrateAskUserDetails(entries);
        assert.equal(out.length, 2);
        assert.equal((out[0] as { message: { details?: unknown } }).message.details, undefined);
    });

    it("does not mutate the original entry object", () => {
        const toolResult = askUserToolResult("tc-1", { waiting: true });
        const user = userMessage(
            `${lt}ask_user_context${gt}answers (JSON): {"q1":"X"}${lt}/ask_user_context${gt}`,
        );
        const entries = [toolResult, user];
        rehydrateAskUserDetails(entries);
        const afterTool = toolResult as {
            message: { details?: { answers?: unknown } };
        };
        assert.equal(afterTool.message.details?.answers, undefined);
    });

    it("matches the most recent askUser toolResult when multiple exist", () => {
        const entries = [
            askUserToolResult("tc-1", { waiting: true }),
            askUserToolResult("tc-2", { waiting: true }),
            userMessage(
                `${lt}ask_user_context${gt}questions (JSON):\n[]\nanswers (JSON):\n${JSON.stringify({ q2: "B" })}${lt}/ask_user_context${gt}`,
            ),
        ];
        const out = rehydrateAskUserDetails(entries);
        const tc1 = out[0] as { message: { details?: { answers?: unknown } } };
        const tc2 = out[1] as { message: { details?: { answers?: unknown } } };
        assert.equal(tc1.message.details?.answers, undefined);
        assert.deepEqual(tc2.message.details?.answers, { q2: "B" });
    });

    it("locks the candidate after a fill — a second injection does not overwrite", () => {
        // Rare but valid: same toolResult followed by two injected user messages (fork / manual jsonl edit).
        // First fill locks the candidate; the second must not overwrite the first answers.
        const mk = (ans: unknown) =>
            `${lt}ask_user_context${gt}questions (JSON):\n[]\nanswers (JSON):\n${JSON.stringify(ans)}${lt}/ask_user_context${gt}`;
        const entries = [
            askUserToolResult("tc-1", { waiting: true }),
            userMessage(mk({ q: "first" })),
            userMessage(mk({ q: "second" })),
        ];
        const out = rehydrateAskUserDetails(entries);
        const tc = out[0] as { message: { details?: { answers?: unknown } } };
        assert.deepEqual(tc.message.details?.answers, { q: "first" });
    });
});
