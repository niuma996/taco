import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
    type AgentMessage,
    asWorkspaceId,
    ErrorCodes,
    type PromptResult,
    PushMethods,
    type RpcRequest,
    type RpcResponse,
    type ServerPush,
    SIDECAR_PROTOCOL_VERSION,
} from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";
import type { ServerFrame } from "../../src/server/transport.ts";
import { InMemoryTransport } from "../_helpers/inMemoryTransport.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

useTempTacoHome("multi-session-rpc");

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function messageText(message: { content: unknown }): string {
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return message.content
        .map((part) =>
            typeof part === "object" &&
            part !== null &&
            "text" in part &&
            typeof part.text === "string"
                ? part.text
                : "",
        )
        .join("\n");
}

type SessionEventPush = ServerPush<{ event?: { type?: string; message?: AgentMessage } }>;
function eventsFor(
    transport: InMemoryTransport,
    target: { workspace: string; sessionId: string },
): SessionEventPush[] {
    return transport.sent.filter(
        (frame): frame is SessionEventPush =>
            !("ok" in frame) &&
            frame.method === PushMethods.Event &&
            frame.workspace === target.workspace &&
            frame.session === target.sessionId,
    );
}

class RpcTransport extends InMemoryTransport {
    private readonly responses = new Map<string, ReturnType<typeof deferred<RpcResponse>>>();

    override async send(frame: ServerFrame): Promise<void> {
        await super.send(frame);
        if ("ok" in frame) {
            this.responses.get(frame.id)?.resolve(frame);
            this.responses.delete(frame.id);
        }
    }

    request(request: RpcRequest): Promise<RpcResponse> {
        assert.ok(!this.responses.has(request.id), "request ids must be unique");
        const response = deferred<RpcResponse>();
        this.responses.set(request.id, response);
        this.simulateRequest(JSON.stringify(request));
        return response.promise;
    }
}

it("runs A1/A2/B1 through ConnectionServer concurrently and aborts only A1", {
    timeout: 20_000,
}, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "taco-multi-session-"));
    const a = asWorkspaceId(join(root, "a"));
    const b = asWorkspaceId(join(root, "b"));
    const targets = [
        { label: "A1", workspace: a, sessionId: "shared-session" },
        { label: "A2", workspace: a, sessionId: "other-session" },
        { label: "B1", workspace: b, sessionId: "shared-session" },
    ] as const;
    const gates = new Map(
        targets.map(({ label }) => [
            label,
            {
                entered: deferred<void>(),
                release: deferred<void>(),
                aborted: deferred<void>(),
                signal: undefined as AbortSignal | undefined,
            },
        ]),
    );
    const providerId = "multi-session-test";
    const faux = fauxProvider({ provider: providerId, tokensPerSecond: 0 });
    const response: FauxResponseFactory = async (context, options) => {
        const text = context.messages
            .filter((message) => message.role === "user")
            .map(messageText)
            .join("\n");
        const target = targets.find(({ label }) => text.includes(`Run ${label}`));
        assert.ok(target, `unexpected model request: ${text}`);
        const gate = gates.get(target.label);
        assert.ok(gate);
        assert.equal(gate.signal, undefined, "busy rejection must not call the provider again");
        const signal = options?.signal;
        assert.ok(signal, "real harness cancellation must reach the provider");
        gate.signal = signal;
        const onAbort = () => gate.aborted.resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            gate.entered.resolve();
            if (signal.aborted) onAbort();
            await Promise.race([gate.release.promise, gate.aborted.promise]);
            return fauxAssistantMessage(`Completed ${target.label}`);
        } finally {
            signal.removeEventListener("abort", onAbort);
        }
    };
    faux.setResponses([response, response, response]);
    const server = new SidecarServer({
        sessionsRoot: join(root, "sessions"),
        providerKeyStore: new ProviderKeyStore({ [providerId]: "test-only-fake-key" }),
        memoryEnabled: false,
        defaultThinkingLevel: "off",
        systemPrompt: "Return the requested test label.",
    });
    const transport = new RpcTransport();
    const pending: Promise<RpcResponse>[] = [];
    t.after(async () => {
        for (const gate of gates.values()) gate.release.resolve();
        await Promise.allSettled(pending);
        await server.stop();
        await rm(root, { recursive: true, force: true });
    });
    await Promise.all([mkdir(a), mkdir(b)]);
    await server.start(transport, []);
    const initialized = await transport.request({
        id: "initialize",
        method: "initialize",
        params: {
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            clientCapabilities: { uiLocale: "en" },
        },
    });
    assert.equal(initialized.ok, true, JSON.stringify(initialized));
    // Keep production workspace construction and push wiring; replace only the model backend.
    for (const cwd of [a, b]) {
        const workspace = await server.ensureWorkspace(cwd);
        workspace.models.setProvider(faux.provider);
        workspace.setDefaultModel(faux.getModel().id, providerId);
    }
    for (const target of targets) {
        const created = await transport.request({
            id: `create-${target.label}`,
            commandId: `create-${target.label}`,
            method: "session.create",
            params: { workspace: target.workspace, sessionId: target.sessionId },
        });
        assert.equal(created.ok, true, JSON.stringify(created));
    }
    for (const target of targets)
        pending.push(
            transport.request({
                id: `prompt-${target.label}`,
                commandId: `prompt-${target.label}`,
                method: "session.prompt",
                params: {
                    workspace: target.workspace,
                    sessionId: target.sessionId,
                    text: `Run ${target.label}`,
                },
            }),
        );
    // A serialized connection/workspace dispatcher cannot reach this barrier while replies are held.
    await Promise.race([
        Promise.all([...gates.values()].map((gate) => gate.entered.promise)),
        Promise.race(pending).then((early) =>
            assert.fail(`prompt settled before all models entered: ${JSON.stringify(early)}`),
        ),
    ]);
    assert.equal(faux.state.callCount, 3);
    for (const target of targets) {
        const starts = transport.sent.filter(
            (frame) =>
                !("ok" in frame) &&
                frame.method === PushMethods.Event &&
                frame.workspace === target.workspace &&
                frame.session === target.sessionId &&
                (frame.params as { event?: { type?: string } }).event?.type === "run_start",
        );
        assert.equal(starts.length, 1, `${target.label} must enter its own run before release`);
        assert.equal(
            transport.sent.some((frame) => "ok" in frame && frame.id === `prompt-${target.label}`),
            false,
        );
    }
    for (const target of targets) {
        const busy = await transport.request({
            id: `overlap-${target.label}`,
            commandId: `overlap-${target.label}`,
            method: "session.prompt",
            params: {
                workspace: target.workspace,
                sessionId: target.sessionId,
                text: "Must not enter the model",
            },
        });
        assert.equal(busy.ok, false);
        if (!busy.ok) assert.equal(busy.error.code, ErrorCodes.SessionBusy);
    }
    assert.equal(faux.state.callCount, 3);
    const stopped = await transport.request({
        id: "stop-A1",
        commandId: "stop-A1",
        method: "session.abort",
        params: { workspace: a, sessionId: targets[0].sessionId },
    });
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    if (stopped.ok) assert.equal((stopped.result as { status: string }).status, "aborted");
    await gates.get("A1")?.aborted.promise;
    assert.equal(gates.get("A1")?.signal?.aborted, true);
    for (const label of ["A2", "B1"] as const) {
        assert.equal(gates.get(label)?.signal?.aborted, false, `${label} must survive stopping A1`);
        assert.equal(
            transport.sent.some((frame) => "ok" in frame && frame.id === `prompt-${label}`),
            false,
        );
        gates.get(label)?.release.resolve();
    }
    const results = await Promise.all(pending);
    const a1 = results[0];
    assert.ok(a1 && !a1.ok, JSON.stringify(a1));
    assert.equal(a1.error.code, ErrorCodes.Aborted);
    for (const [index, target] of targets.entries()) {
        const result = results[index];
        if (index > 0) {
            assert.ok(result?.ok, JSON.stringify(result));
            assert.equal(
                messageText((result.result as PromptResult).assistantMessage),
                `Completed ${target.label}`,
            );
        }
        const events = eventsFor(transport, target);
        const ends = events.filter(
            (frame) => (frame.params as { event?: { type?: string } }).event?.type === "run_end",
        );
        assert.equal(ends.length, 1, `${target.label} must settle its own run`);
        const replies = events.flatMap((frame) => {
            const event = (
                frame.params as {
                    event?: { type?: string; message?: PromptResult["assistantMessage"] };
                }
            ).event;
            return event?.type === "message_end" && event.message?.role === "assistant"
                ? [messageText(event.message)]
                : [];
        });
        if (index > 0) assert.deepEqual(replies, [`Completed ${target.label}`]);
        else
            assert.ok(
                replies.every(
                    (text) => !text.includes("Completed A2") && !text.includes("Completed B1"),
                ),
            );
    }
    assert.equal(
        faux.state.callCount,
        3,
        "neither busy rejection nor abort may start another model call",
    );
});
