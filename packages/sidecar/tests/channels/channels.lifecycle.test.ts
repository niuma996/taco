import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { asSessionId, asWorkspaceId, makeImCwd } from "@taco-ai/protocol";
import { WeComChannel } from "../../src/channels/builtin/wecomChannel.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { InMemoryTransport } from "../_helpers/inMemoryTransport.ts";

for (const mode of [
    "main",
    "main with subagent",
    "main during subagent setup",
    "subagent",
] as const) {
    it(`delivers WeCom replies after stopping ${mode} and another inbound message`, {
        timeout: 10_000,
    }, async (t) => {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        t.after(() => server.stop());
        const transport = new InMemoryTransport();
        await server.start(transport);
        const sent: { chatId: string; body: unknown }[] = [];
        const client = Object.assign(new EventEmitter(), {
            connect() {},
            disconnect() {},
            async sendMessage(chatId: string, body: { msgtype: string; [key: string]: unknown }) {
                sent.push({ chatId, body });
            },
            async downloadFile() {
                return { buffer: Buffer.alloc(0) };
            },
        });
        const channel = new WeComChannel({
            broker: server.channelBindBroker,
            resolveRoute: (sid) => server.conversationRouterView?.findRouteBySessionId(sid),
            createClient: () => client,
        });
        const ctx = server.buildChannelContext("wecom");
        const handle = await channel.start(ctx);
        server.channelRegistry.register("wecom", channel, handle);
        await handle.login?.(false, { botId: "test", secret: "test" });
        client.emit("authenticated");
        const workspaceId = asWorkspaceId(makeImCwd("wecom", "u1", "c1"));
        const workspace = await server.ensureWorkspace(workspaceId);
        const faux = fauxProvider({ provider: "faux", tokensPerSecond: 50 });
        workspace.models.setProvider(faux.provider);
        workspace.setDefaultModel(faux.getModel().id, "faux");
        workspace.agentSpawner.replaceAgents([
            {
                agentType: "explorer",
                description: "test",
                systemPrompt: "test",
                source: "builtin",
                filePath: "/test.md",
            },
        ]);
        const longReply = fauxAssistantMessage([fauxText("a long response ".repeat(100))]);
        faux.setResponses(
            mode === "main"
                ? [longReply]
                : [
                      fauxAssistantMessage([
                          fauxToolCall("agent", {
                              subagent_type: "explorer",
                              description: "test child",
                              prompt: "go",
                          }),
                      ]),
                      longReply,
                      fauxAssistantMessage([fauxText("parent finished")]),
                  ],
        );
        let childId: string | undefined;
        workspace.on("subagent.spawned", (e) => {
            childId = e.subSessionId;
        });
        let releaseSetup: (() => void) | undefined;
        let enteredSetup: (() => void) | undefined;
        const setupStarted = new Promise<void>((resolve) => {
            enteredSetup = resolve;
        });
        if (mode === "main during subagent setup") {
            const gate = new Promise<void>((resolve) => {
                releaseSetup = resolve;
            });
            const attachChild = workspace.sessionRegistry.attachChild.bind(
                workspace.sessionRegistry,
            );
            workspace.sessionRegistry.attachChild = async (...args) => {
                if (
                    args[0] !==
                    server.conversationRouterView?.lookupByWorkspace(workspaceId)?.sessionId
                ) {
                    enteredSetup?.();
                    await gate;
                }
                return attachChild(...args);
            };
        }
        const delta = new Promise<void>((resolve) => {
            workspace.on("session.event", (e) => {
                if (
                    e.event?.type === "message_update" &&
                    (mode === "main" || e.sessionId === childId)
                )
                    resolve();
            });
        });
        const inbound = (id: string) =>
            ctx.ingress.submit({
                channelId: "wecom",
                peerId: "u1",
                chatId: "c1",
                platformMessageId: `${mode}:${id}`,
                text: id,
                kind: "text",
            });
        const first = inbound("first");
        await (mode === "main during subagent setup" ? setupStarted : delta);
        const sessionId = server.conversationRouterView?.lookupByWorkspace(workspaceId)?.sessionId;
        assert.ok(sessionId);
        if (mode !== "main") assert.ok(childId);
        let abortStarted: Promise<void> | undefined;
        if (mode === "main during subagent setup") {
            const parent = workspace.getAttached(asSessionId(sessionId));
            assert.ok(parent);
            const abort = parent.abort.bind(parent);
            abortStarted = new Promise<void>((resolve) => {
                parent.abort = async () => {
                    const pending = abort();
                    resolve();
                    return pending;
                };
            });
        }
        const aborting = server.dispatchRpc({
            id: "abort",
            method: mode === "subagent" ? "subagent.abort" : "session.abort",
            params:
                mode === "subagent"
                    ? { workspace: workspaceId, subSessionId: asSessionId(childId ?? "") }
                    : { workspace: workspaceId, sessionId: asSessionId(sessionId) },
        });
        await abortStarted;
        releaseSetup?.();
        const aborted = await aborting;
        assert.ok(aborted.ok, JSON.stringify(aborted));
        await first;
        faux.setResponses([fauxAssistantMessage([fauxText("reply after stop")])]);
        const second = await inbound("second");
        assert.equal(second.sessionId, sessionId);
        assert.deepEqual(server.conversationRouterView?.findRouteBySessionId(sessionId), {
            channelId: "wecom",
            peerId: "u1",
            chatId: "c1",
        });
        const history = await workspace.getHistory(asSessionId(sessionId));
        assert.ok(
            history.entries.some(
                (e) =>
                    e.type === "message" &&
                    e.message.role === "assistant" &&
                    JSON.stringify(e.message.content).includes("reply after stop"),
            ),
        );
        const childSessionId = asSessionId(childId ?? "child-reply");
        workspace.sessionRegistry.noteSessionKind(childSessionId, "subagent");
        const childFrames: unknown[] = [];
        const originalPush = handle.push.bind(handle);
        handle.push = async (frame) => {
            if (frame.session === childSessionId) childFrames.push(frame);
            await originalPush(frame);
        };
        workspace.emit("session.event", {
            sessionId: childSessionId,
            event: {
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "child output" }] },
            },
        });
        await server.channelRegistry.stop("wecom");
        assert.equal(childFrames.length, 0, "child replies belong to the parent, not the IM sink");
        assert.ok(
            transport.sent.some((frame) => "session" in frame && frame.session === childSessionId),
            "desktop still receives child events",
        );
        assert.ok(
            sent.some(
                (message) =>
                    message.chatId === "c1" &&
                    JSON.stringify(message.body).includes("reply after stop"),
            ),
        );
    });
}
