import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import type { SubagentSpawnContext } from "../../src/agents/types.ts";
import type { ToolResultHook } from "../../src/extensions/types.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { createPlanModeState } from "../../src/plan/planModeState.ts";
import { AttachedSession } from "../../src/runtime/harness/attachedSession.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import type { AgentMessage } from "../../src/runtime/pi/types.ts";
import { JsonlSessionRepo } from "../../src/runtime/pi/values.ts";
import { findBranchEntries } from "../../src/runtime/session/sessionBranch.ts";
import { createAgentTool } from "../../src/tools/agent.ts";

type SpawnResult = Awaited<ReturnType<SubagentSpawnContext["spawn"]>>;
type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;
interface PersistenceCase {
    name: string;
    toolName?: string;
    outcome: SpawnResult;
    status: string;
    text?: string;
    extensionHook?: ToolResultHook;
    expectedIsError?: boolean;
    expectedDetails?: ToolResult["details"];
}

describe("agent tool result persistence through the real harness", { timeout: 8_000 }, () => {
    const childId = asSessionId("kept-child");
    const cases: PersistenceCase[] = [
        ...[false, true].flatMap((background) =>
            (["create_session", "prepare_attach", "attach"] as const).map((failurePhase) => ({
                name: `${background ? "background" : "synchronous"} ${failurePhase} failure metadata`,
                outcome: {
                    ...(failurePhase === "create_session" ? {} : { subSessionId: childId }),
                    resultText: `Startup failed during ${failurePhase}.`,
                    isError: true,
                    background,
                    failurePhase,
                },
                status: "error",
            })),
        ),
        {
            name: "synchronous startup failure with retained child history",
            outcome: { subSessionId: childId, resultText: "attach failed", isError: true },
            status: "error",
            text: "subagent error: attach failed\n\n[subagent session: kept-child]",
        },
        {
            name: "background startup failure with retained child history",
            outcome: {
                subSessionId: childId,
                resultText: "attach failed",
                isError: true,
                background: true,
            },
            status: "error",
            text: "failed to launch background subagent: attach failed",
        },
        {
            name: "background failure before a child exists",
            outcome: { resultText: "create failed", isError: true, background: true },
            status: "error",
            text: "failed to launch background subagent: create failed",
        },
        {
            name: "successful synchronous completion",
            outcome: { subSessionId: childId, resultText: "done", isError: false },
            status: "completed",
            text: "done\n\n[subagent session: kept-child]",
        },
        {
            name: "successful background launch",
            outcome: {
                subSessionId: childId,
                resultText: "",
                isError: false,
                background: true,
            },
            status: "launched",
        },
        {
            name: "deliberately aborted synchronous child",
            outcome: {
                subSessionId: childId,
                resultText: "stopped",
                isError: true,
                aborted: true,
            },
            status: "aborted",
            text: "subagent error: stopped\n\n[subagent session: kept-child]",
        },
        {
            name: "extension content and details edits without losing the error flag",
            outcome: { subSessionId: childId, resultText: "attach failed", isError: true },
            status: "error",
            extensionHook(event) {
                assert.equal(event.isError, true, "extensions must see the corrected error flag");
                return {
                    content: [{ type: "text", text: "Redacted failure" }],
                    details: { status: "error", subSessionId: childId, redacted: true },
                };
            },
            text: "Redacted failure",
            expectedDetails: { status: "error", subSessionId: childId, redacted: true },
        },
        {
            name: "explicit extension override of an agent error",
            outcome: { subSessionId: childId, resultText: "attach failed", isError: true },
            status: "error",
            extensionHook(event) {
                assert.equal(event.isError, true, "extensions must see the corrected error flag");
                return { isError: false };
            },
            expectedIsError: false,
            text: "subagent error: attach failed\n\n[subagent session: kept-child]",
        },
        {
            name: "explicit extension error on an otherwise successful agent result",
            outcome: { subSessionId: childId, resultText: "done", isError: false },
            status: "completed",
            extensionHook(event) {
                assert.equal(event.isError, false);
                return { isError: true };
            },
            expectedIsError: true,
            text: "done\n\n[subagent session: kept-child]",
        },
        {
            name: "unrelated tool with error-shaped details without inferring its error flag",
            toolName: "unrelated",
            outcome: { subSessionId: childId, resultText: "attach failed", isError: true },
            status: "error",
            expectedIsError: false,
            text: "subagent error: attach failed\n\n[subagent session: kept-child]",
        },
    ];

    for (const testCase of cases) {
        it(`serializes ${testCase.name}`, async (t) => {
            const root = await mkdtemp(join(tmpdir(), "taco-agent-persistence-"));
            t.after(() => rm(root, { recursive: true, force: true }));
            const env = new NodeExecutionEnv({ cwd: root });
            const repo = new JsonlSessionRepo({
                fileSystem: env,
                sessionsRoot: join(root, "sessions"),
            });
            const outcome: SpawnResult = testCase.outcome;
            const toolName = testCase.toolName ?? "agent";
            // Only the spawn boundary is controlled. The tool, sidecar hooks,
            // harness execution, JSONL commit and subsequent reopen are real.
            const tool = createAgentTool(
                {
                    async spawn(args) {
                        assert.equal(args.parentToolCallId, "agent-call");
                        assert.equal(args.background, outcome.background ?? false);
                        return outcome;
                    },
                    abortSubagent: () => ({ stopped: false }),
                },
                [{ agentType: "reviewer" }],
            );
            // Reuse the same result shape under another name to prove that the
            // compatibility bridge never interprets unrelated tools' details.
            tool.name = toolName;
            const faux = fauxProvider({ provider: "agent-persistence", tokensPerSecond: 0 });
            let modelResult: ToolResult | undefined;
            faux.setResponses([
                fauxAssistantMessage(
                    fauxToolCall(
                        toolName,
                        {
                            subagent_type: "reviewer",
                            description: "review change",
                            prompt: "review change",
                            background: outcome.background ?? false,
                        },
                        { id: "agent-call" },
                    ),
                    { stopReason: "toolUse" },
                ),
                (context) => {
                    const result = context.messages.find(
                        (message) => message.role === "toolResult",
                    );
                    assert.ok(result && result.role === "toolResult");
                    modelResult = result;
                    return fauxAssistantMessage("Parent handled the result.");
                },
            ]);
            const models = createModels();
            models.setProvider(faux.provider);
            const session = await repo.create({ cwd: root }, harnessContext);
            let extensionInputIsError: boolean | undefined;
            const attached = await AttachedSession.create({
                session,
                sessionKind: "main",
                models,
                model: faux.getModel(),
                env,
                systemPrompt: "Delegate once, then report the result.",
                tools: [tool],
                resources: {},
                streamOptions: {},
                extensionToolResultHooks: {
                    builtins: [],
                    external: testCase.extensionHook
                        ? [
                              (event) => {
                                  extensionInputIsError = event.isError;
                                  return testCase.extensionHook?.(event);
                              },
                          ]
                        : [],
                },
                compaction: { enabled: false, threshold: 0 },
                taskStore: { currentListId: null, lists: new Map() },
                planState: createPlanModeState(),
                tasksDir: root,
                attachmentsDir: root,
                sessionCwd: asWorkspaceId(root),
                getToolContext: () => ({ env, workspace: asWorkspaceId(root) }),
            });
            t.after(() => attached.dispose());
            await attached.prompt("Delegate the review.");
            if (testCase.extensionHook) {
                assert.equal(extensionInputIsError, outcome.isError);
            }
            await attached.dispose();
            await session.close(harnessContext);

            const writes = (await readFile(session.metadata.path, "utf8"))
                .trim()
                .split("\n")
                .flatMap((line) => JSON.parse(line));
            const persisted = writes.filter(
                (write) =>
                    write.kind === "entry" &&
                    write.type === "message" &&
                    write.message.role === "toolResult",
            );
            assert.equal(persisted.length, 1, "exactly one agent result must be committed");
            const expectedDetails = {
                status: testCase.status,
                agentType: "reviewer",
                ...(outcome.subSessionId ? { subSessionId: outcome.subSessionId } : {}),
                ...(outcome.failurePhase === undefined
                    ? {}
                    : { failurePhase: outcome.failurePhase }),
            };
            const persistedResult: ToolResult = persisted[0].message;
            const reopened = await repo.open(session.metadata, harnessContext);
            t.after(() => reopened.close(harnessContext));
            const history = await findBranchEntries(reopened);
            const results = history.flatMap((entry) =>
                entry.type === "message" && entry.message.role === "toolResult"
                    ? [entry.message]
                    : [],
            );
            assert.deepEqual(
                results,
                [persistedResult],
                "reopened parent history must retain the result",
            );
            assert.deepEqual(persistedResult.details, testCase.expectedDetails ?? expectedDetails);
            const expectedIsError = testCase.expectedIsError ?? outcome.isError;
            assert.equal(persistedResult.isError, expectedIsError, "raw parent JSONL error flag");
            assert.equal(persistedResult.toolName, toolName);
            assert.equal(persistedResult.toolCallId, "agent-call");
            assert.ok(modelResult, "parent must consume the real tool result on its next turn");
            assert.equal(modelResult.isError, expectedIsError, "model-facing error flag");
            if (testCase.text !== undefined) {
                assert.deepEqual(persistedResult.content, [{ type: "text", text: testCase.text }]);
            } else if (!outcome.isError) {
                assert.match(JSON.stringify(persistedResult.content), /launched in background/);
            } else {
                assert.match(JSON.stringify(persistedResult.content), /Startup failed during/);
            }
        });
    }
});
