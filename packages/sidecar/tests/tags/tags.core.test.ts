// Core tag tests: parser/builder/policy, active-tasks hook, fact serialization, file-op extraction.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createPlanModeState } from "../../src/plan/planModeState.ts";
import type { AgentMessage } from "../../src/runtime/pi/types.ts";
import { parseAskUserContext, rehydrateAskUserDetails } from "../../src/tags/askUserRehydrate.ts";
import { tagWrap } from "../../src/tags/builder.ts";
import { serializeMessagesForFacts } from "../../src/tags/factExtractor.ts";
import { detectFences, findBalancedTagsSkippingFences } from "../../src/tags/fenceAware.ts";
import { findBalancedTags } from "../../src/tags/parser.ts";
import {
    collectDropRanges,
    stripDropTagsFromMessages,
    stripDropTagsInText,
} from "../../src/tags/policy/dropPolicy.ts";
import { extractExtendedFileOps } from "../../src/tags/policy/extendedFileOps.ts";
import { stripRanges } from "../../src/tags/policy/textRanges.ts";
import {
    isContentEmptyAfterVisibility,
    stripEphemeralTagWrappers,
    stripHiddenTagsInMarkdown,
} from "../../src/tags/policy/visibility.ts";
import { tagRegistry } from "../../src/tags/registry.ts";
import { buildActiveTasksContextHook } from "../../src/tasks/activeTasksTag.ts";
import { createTaskStore } from "../../src/tasks/createTaskStore.ts";
import { addTask, createTaskList } from "../../src/tasks/taskMutations.ts";
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

    it("does not match colon-form skill_body:NAME as skill_body", () => {
        const text = `${lt}skill_body:demo${gt}body${lt}/skill_body:demo${gt}`;
        assert.equal(findBalancedTags(text, "skill_body").length, 0);
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

    // A background subagent's completion notice is injected as a user message
    // into the parent session. Its whole body is machine-facing (a path plus
    // instructions to the model), so it must clean to empty — both the push
    // path (server.ts) and history replay (sessionRead.ts) drop a message that
    // does, which is what keeps it from rendering as a blank chat bubble.
    it("hides a background subagent completion notice entirely", () => {
        const notice = tagWrap(
            "subagent_result",
            "The explorer subagent you launched in the background has finished.\n" +
                "Its full output is saved at: /tmp/sessions/p1/subagent-results/c1.md",
            { "agent-type": "explorer", session: "c1", outcome: "completed" },
        );
        const cleaned = stripHiddenTagsInMarkdown(notice, [tagRegistry.subagent_result.name]);
        assert.equal(
            isContentEmptyAfterVisibility([{ type: "text", text: cleaned }]),
            true,
            "notice must leave nothing visible, or it renders as an empty bubble",
        );
    });

    it("registers subagent_result as hidden but never dropped from context", () => {
        assert.equal(tagRegistry.subagent_result.tuiVisibility, "hidden");
        // `drop` is enforced by a context hook on every LLM call, not only at
        // compaction, so it would erase this notice before the model read it:
        // the parent wakes up to an empty delivery and reports the subagent as
        // still running. Regression guard for exactly that.
        assert.notEqual(
            tagRegistry.subagent_result.compression.kind,
            "drop",
            "a drop-policy notice is stripped from context before the model sees it",
        );
    });

    // The notice must survive the same context hook the harness installs for
    // every LLM call — hidden from the user, intact for the model.
    it("keeps a subagent_result notice in LLM context", () => {
        const notice = tagWrap("subagent_result", "finished; output at /tmp/r.md", {
            outcome: "completed",
        });
        const [msg] = stripDropTagsFromMessages([
            { role: "user", content: [{ type: "text", text: notice }] },
        ]);
        const text = (msg as { content: { text?: string }[] }).content[0]?.text ?? "";
        assert.match(text, /output at \/tmp\/r\.md/);
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

function makeState(store: ReturnType<typeof createTaskStore>, planActive: boolean) {
    return { store, planActive, planState: createPlanModeState() };
}

function ctxWith(messages: unknown[]) {
    return { messages } as never;
}

describe("active_tasks tag", () => {
    it("injects unfinished-task guidance when active list has unfinished tasks", async () => {
        const store = createTaskStore("/ws");
        createTaskList(store, "l1", "深圳骑行");
        addTask(store, "l1", { content: "查天气", status: "pending", activeForm: "查天气" });
        store.currentListId = "l1";
        const hook = buildActiveTasksContextHook(() => makeState(store, false));
        const res = await hook(ctxWith([]));
        const text = JSON.stringify(res);
        assert.match(text, /active_tasks/);
        assert.match(text, /查天气/);
    });

    it("injects nothing when all tasks completed", async () => {
        const store = createTaskStore("/ws");
        createTaskList(store, "l1", "A");
        addTask(store, "l1", { content: "x", status: "completed", activeForm: "x" });
        store.currentListId = "l1";
        const hook = buildActiveTasksContextHook(() => makeState(store, false));
        const res = await hook(ctxWith([]));
        assert.equal(res, undefined);
    });

    it("suppresses injection while plan mode is active", async () => {
        const store = createTaskStore("/ws");
        createTaskList(store, "l1", "A");
        addTask(store, "l1", { content: "x", status: "pending", activeForm: "x" });
        store.currentListId = "l1";
        const hook = buildActiveTasksContextHook(() => makeState(store, true));
        const res = await hook(ctxWith([]));
        assert.equal(res, undefined);
    });
});

const mkFact = (m: Record<string, unknown>): AgentMessage => m as unknown as AgentMessage;

describe("serializeMessagesForFacts", () => {
    it("renders role + content for string messages", () => {
        const out = serializeMessagesForFacts([
            mkFact({ role: "user", content: "hi" }),
            mkFact({ role: "assistant", content: "yo" }),
        ]);
        assert.match(out, /\[user\]\nhi/);
        assert.match(out, /\[assistant\]\nyo/);
    });

    it("renders text blocks of block-array content", () => {
        const out = serializeMessagesForFacts([
            mkFact({
                role: "assistant",
                content: [
                    { type: "text", text: "hello" },
                    { type: "text", text: "world" },
                ],
            }),
        ]);
        assert.match(out, /hello\nworld/);
    });

    it("ignores unknown / non-text blocks", () => {
        const out = serializeMessagesForFacts([
            mkFact({
                role: "assistant",
                content: [
                    { type: "text", text: "before" },
                    { type: "image", image: "fake" },
                    { type: "text", text: "after" },
                ],
            }),
        ]);
        assert.match(out, /before.*after/s);
        assert.equal(out.includes("image"), false);
    });

    it("handles messages with non-content gracefully", () => {
        const out = serializeMessagesForFacts([mkFact({ role: "user" })]);
        assert.match(out, /\[user\]/);
    });

    it("returns empty string for empty input", () => {
        assert.equal(serializeMessagesForFacts([]), "");
    });
});

// Minimal AgentMessage-shaped fixtures (real harness messages carry many
// more fields the helper doesn't care about).
const mkFileOp = (m: Record<string, unknown>): AgentMessage => m as unknown as AgentMessage;

// Fixtures mirror pi's real `ToolCall` block shape (`name` / `arguments`, not
// `toolName` / `args`) — an earlier revision of this file used the wrong field
// names, which is exactly what let the extractor's matching bug go unnoticed.
function assistantCall(toolName: string, args: unknown) {
    return mkFileOp({
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: toolName, arguments: args }],
    });
}

function assistantText(text: string) {
    return mkFileOp({ role: "assistant", content: text });
}

describe("extractExtendedFileOps — shell", () => {
    it("flags >> and > as writes", () => {
        const messages = [assistantCall("shell", { command: "echo hi >> /tmp/out.log" })];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraModifiedFiles.includes("/tmp/out.log"));
        assert.equal(out.extraReadFiles.includes("/tmp/out.log"), false);
    });

    it("flags sed -i as a write", () => {
        const messages = [assistantCall("shell", { command: "sed -i 's/a/b/' /etc/conf.yaml" })];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraModifiedFiles.includes("/etc/conf.yaml"));
    });

    it("flags heredoc body rewrite as a write", () => {
        const cmd = `cat <<EOF > /etc/app.env
NEW=value
EOF`;
        const messages = [assistantCall("shell", { command: cmd })];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraModifiedFiles.includes("/etc/app.env"));
    });

    it("flags mv src dst as writes (dst modifies, src tracked as read)", () => {
        const messages = [assistantCall("shell", { command: "mv old.log archive/old.log" })];
        const out = extractExtendedFileOps(messages);
        // Destination file count as a write.
        assert.ok(out.extraModifiedFiles.includes("archive/old.log"));
        // Source path doesn't get a free read modifier under mv alone — we
        // verify NO false-positive write for the source filename.
        assert.equal(out.extraModifiedFiles.includes("old.log"), false);
    });

    it("flags cp as a write", () => {
        const messages = [assistantCall("shell", { command: "cp src.txt backup.txt" })];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraModifiedFiles.includes("backup.txt"));
    });

    it("flags rm as a write", () => {
        const messages = [assistantCall("shell", { command: "rm /var/log/x.log" })];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraModifiedFiles.includes("/var/log/x.log"));
    });

    it("flags cat as a read (not a write)", () => {
        const messages = [assistantCall("shell", { command: "cat /etc/hosts" })];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraReadFiles.includes("/etc/hosts"));
        assert.equal(out.extraModifiedFiles.includes("/etc/hosts"), false);
    });

    it("ignores shell snippets inside fenced code blocks", () => {
        const messages = [assistantText("```bash\nsed -i 's/a/b/' /tmp/fenced\n```")];
        const out = extractExtendedFileOps(messages);
        // Text content is not a tool-call block → nothing extracted.
        assert.equal(out.extraModifiedFiles.length, 0);
        assert.equal(out.extraReadFiles.length, 0);
    });

    it("handles missing or empty command arguments", () => {
        const messages = [assistantCall("shell", {})];
        const out = extractExtendedFileOps(messages);
        assert.deepEqual(out, { extraReadFiles: [], extraModifiedFiles: [] });
    });

    it("does not match legacy bash/powershell tool names", () => {
        // After unifying bash + powershell into `shell`, only `shell` is
        // scanned. Legacy names in tool-call blocks are ignored so old
        // transcripts don't reintroduce file-op detection against a tool
        // that no longer exists.
        const messages = [
            assistantCall("bash", { command: "sed -i 's/a/b/' /tmp/legacy.txt" }),
            assistantCall("powershell", { command: "rm /tmp/legacy2.txt" }),
        ];
        const out = extractExtendedFileOps(messages);
        assert.deepEqual(out, { extraReadFiles: [], extraModifiedFiles: [] });
    });
});

describe("extractExtendedFileOps — glob/grep", () => {
    it("glob path field becomes a read", () => {
        const messages = [assistantCall("glob", { path: "/repo/src/**/*.ts" })];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraReadFiles.includes("/repo/src/**/*.ts"));
    });

    it("grep pattern containing literal paths produces reads", () => {
        const messages = [
            assistantCall("grep", {
                pattern: "TODO",
                dir: "/workspace",
            }),
        ];
        const out = extractExtendedFileOps(messages);
        assert.ok(out.extraReadFiles.includes("/workspace"));
    });
});
