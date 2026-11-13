import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { SessionHistory } from "@taco-ai/protocol";
import { viewUserContent } from "../../src/attachments/userMessageView.ts";
import { toSessionRuntimeSnapshot } from "../../src/runtime/harness/sessionRuntimeSnapshot.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { registerBuiltinMethods } from "../../src/server/methods.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { tagWrap } from "../../src/tags/builder.ts";
import { callMethod } from "../_helpers/handlerCall.ts";

registerBuiltinMethods();

describe("agent message display", () => {
    for (const relation of ["parent", "peer"] as const) {
        const provenance = { messageId: "delivery-1", senderSessionId: "sender", relation };
        const envelope = tagWrap("agent_message", "x".repeat(438), {
            id: provenance.messageId,
            from: provenance.senderSessionId,
            relation,
        });
        const message = { role: "user" as const, content: envelope, timestamp: 1000 };

        it(`shows ${relation} content with structured provenance without changing the stored envelope`, () => {
            const view = viewUserContent(message.content);
            assert.equal(view.content, "x".repeat(438));
            assert.equal(view.empty, false);
            assert.deepEqual(view, {
                content: "x".repeat(438),
                attachments: [],
                empty: false,
                agentProvenance: provenance,
            });
            assert.equal(message.content, envelope);
        });

        it(`keeps ${relation} provenance consistent in history, live pushes and snapshot queues`, async () => {
            const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
            try {
                const history = await callMethod<SessionHistory>("session.history", {
                    server,
                    params: { workspace: "/w", sessionId: "child" },
                    workspace: {
                        getHistory: async () => ({
                            leafEntryId: "entry-1",
                            entries: [
                                {
                                    id: "entry-1",
                                    parentId: null,
                                    type: "message",
                                    timestamp: 1000,
                                    message,
                                },
                            ],
                        }),
                    },
                });
                const pushes: Array<{ event: { message: unknown } }> = [];
                const seam = server as unknown as {
                    wireWorkspacePush(ws: EventEmitter, workspace: string): void;
                    emitPush(
                        method: string,
                        workspace: string,
                        session: string,
                        params: { event: { message: unknown } },
                    ): void;
                };
                const ws = Object.assign(new EventEmitter(), {
                    permissionBroker: new EventEmitter(),
                });
                seam.emitPush = (_method, _workspace, _session, params) => pushes.push(params);
                seam.wireWorkspacePush(ws, "/w");
                ws.emit("session.event", {
                    sessionId: "child",
                    event: { type: "message_end", message },
                });
                const runtime = toSessionRuntimeSnapshot(
                    {
                        transcript: [],
                        operation: null,
                        queues: [{ type: "message", entryId: "entry-1", kind: "steer", message }],
                    } as never,
                    {
                        pendingCommandPermissions: [],
                        inFlightAgentToolCallIds: [],
                        settledBackgroundSubSessionIds: [],
                    },
                );
                const expected = {
                    ...message,
                    content: "x".repeat(438),
                    agentProvenance: provenance,
                };
                assert.deepEqual(history.entries[0]?.payload, expected);
                assert.deepEqual(pushes[0]?.event.message, expected);
                assert.deepEqual(runtime.queues[0]?.message, expected);
                assert.equal(message.content, envelope);
            } finally {
                await server.stop();
            }
        });
    }

    it("keeps other hidden tags hidden inside and around the envelope", () => {
        const content = [
            {
                type: "text" as const,
                text: '<env>private</env><agent_message from="sender" relation="peer">hello<subagent_result>private path</subagent_result></agent_message>',
            },
        ];
        assert.deepEqual(viewUserContent(content), {
            content: [{ type: "text", text: "hello" }],
            attachments: [],
            empty: false,
            agentProvenance: { senderSessionId: "sender", relation: "peer" },
        });
        assert.equal(
            viewUserContent("<subagent_result>private path</subagent_result>").empty,
            true,
        );
    });

    it("does not label human text, fenced examples or incomplete metadata as an agent delivery", () => {
        for (const text of [
            "hello",
            '```xml\n<agent_message from="sender" relation="peer">example</agent_message>\n```',
            'Example: <agent_message from="sender" relation="peer">example</agent_message>',
            '<agent_message from="sender" relation="other">example</agent_message>',
        ]) {
            assert.equal(Object.hasOwn(viewUserContent(text), "agentProvenance"), false);
        }
    });
});
