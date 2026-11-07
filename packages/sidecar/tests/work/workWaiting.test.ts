import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
    type AgentMessage,
    asSessionId,
    asToolCallId,
    type CommandPermissionRequest,
} from "@taco-ai/protocol";
import { resolveWaitingInteraction } from "../../src/runtime/session/waitingInteraction.ts";
import { WorkService } from "../../src/work/workService.ts";
import { WorkStore } from "../../src/work/workStore.ts";

const waitingMessage = (toolName = "askUser"): AgentMessage => ({
    role: "toolResult",
    toolName,
    toolCallId: "q-1",
    content: [],
    isError: false,
    timestamp: 1,
    details: { waiting: true, questions: [{ question: "Which approach?" }] },
});
const answer: AgentMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Done" }],
    timestamp: 2,
};

async function rig(t: { after(fn: () => Promise<void>): void }) {
    const root = await mkdtemp(join(tmpdir(), "taco-work-waiting-"));
    const changes: string[] = [];
    const options = {
        root,
        instanceId: "instance-1",
        channels: {
            sendText: async () => ({ kind: "confirmed" as const }),
            maxMessageLength: () => 2000,
        },
        resolveRoute: () => undefined,
        onChange: (id: string) => {
            changes.push(id);
        },
    };
    const service = new WorkService(options);
    t.after(async () => {
        service.stop();
        await rm(root, { recursive: true, force: true });
    });
    return { service, root, options, changes };
}

it("recognizes only successful askUser/planExit waiting results and bounds their description", () => {
    for (const tool of ["askUser", "planExit"]) {
        assert.equal(
            resolveWaitingInteraction(waitingMessage(tool), "s")?.description,
            "Which approach?",
        );
    }
    assert.equal(resolveWaitingInteraction({ ...waitingMessage(), isError: true }, "s"), undefined);
    assert.equal(resolveWaitingInteraction(waitingMessage("shell"), "s"), undefined);
    assert.equal(resolveWaitingInteraction(answer, "s"), undefined);
});

it("keeps scheduled work waiting across restart without completion delivery", async (t) => {
    const { service, root, options } = await rig(t);
    const workId = await service.onFire({
        jobId: "j",
        fireId: "f",
        title: "Review",
        workspace: "/a",
        sessionId: "s",
    });
    assert.ok(workId);
    const waiting = resolveWaitingInteraction(waitingMessage(), "s");
    assert.ok(waiting);
    await service.onFireSettle(workId, { outcome: "waiting", waiting });
    const stored = await new WorkStore(root).get(workId);
    assert.equal(stored?.status, "waiting");
    assert.equal(stored?.endedAt, undefined);
    assert.equal(stored?.delivery, undefined);
    const restarted = new WorkService({ ...options, instanceId: "instance-2" });
    t.after(async () => {
        restarted.stop();
    });
    await restarted.start();
    const list = await restarted.list({});
    assert.equal(list.active[0]?.status, "waiting");
    assert.equal(list.active[0]?.needsAttention, true);
    assert.equal(list.terminal.length, 0);
    assert.equal(list.active[0]?.waiting?.toolCallId, "q-1");
});

it("answers the same Work with a fresh attempt and ignores late completion of the old attempt", async (t) => {
    const { service } = await rig(t);
    const w = await service.controller.startScheduled({
        jobId: "j",
        title: "Review",
        sourceEventId: "j:f",
        workspace: "/a",
        sessionId: "s",
    });
    const waiting = resolveWaitingInteraction(waitingMessage(), "s");
    assert.ok(waiting);
    await service.controller.waitForInput(w.workId, waiting);
    await service.answerWaiting({ workspace: "/a", sessionId: "s" }, "q-1", async () => {
        const active = await service.store.get(w.workId);
        assert.equal(active?.status, "running");
        assert.notEqual(active?.attempt.attemptId, w.attempt.attemptId);
        await service.controller.settle({
            workId: w.workId,
            attemptId: w.attempt.attemptId,
            outcome: "completed",
            resultText: "old",
            parentWillReply: false,
        });
        assert.equal((await service.store.get(w.workId))?.status, "running");
        return answer;
    });
    assert.equal((await service.get(w.workId)).work?.status, "completed");
    assert.equal((await service.get(w.workId)).resultText, "Done");
});

it("does not resume another workspace or tool, and retains a second question", async (t) => {
    const { service } = await rig(t);
    const a = await service.controller.startScheduled({
        jobId: "j",
        title: "A",
        sourceEventId: "j:a",
        workspace: "/a",
        sessionId: "s",
    });
    const b = await service.controller.startScheduled({
        jobId: "j",
        title: "B",
        sourceEventId: "j:b",
        workspace: "/b",
        sessionId: "s",
    });
    const waiting = resolveWaitingInteraction(waitingMessage(), "s");
    assert.ok(waiting);
    await service.controller.waitForInput(a.workId, waiting);
    await service.controller.waitForInput(b.workId, waiting);
    await service.answerWaiting({ workspace: "/a", sessionId: "s" }, "q-other", async () => answer);
    assert.equal((await service.get(a.workId)).work?.status, "waiting");
    await service.answerWaiting({ workspace: "/a", sessionId: "s" }, "q-1", async () => ({
        ...waitingMessage("planExit"),
        toolCallId: "q-2",
    }));
    assert.equal((await service.get(a.workId)).work?.waiting?.toolCallId, "q-2");
    assert.equal((await service.get(b.workId)).work?.waiting?.toolCallId, "q-1");
});

it("projects broker requests without persisting approval or trusting a restarted request id", async (t) => {
    const { service, root, options } = await rig(t);
    const w = await service.controller.startScheduled({
        jobId: "j",
        title: "Run",
        sourceEventId: "j:p",
        workspace: "/a",
        sessionId: "s",
    });
    const request: CommandPermissionRequest = {
        requestId: "r-1",
        sessionId: asSessionId("s"),
        toolCallId: asToolCallId("shell-1"),
        command: "secret",
        evaluation: { behavior: "ask", risk: "workspaceWrite", reason: "needs approval" },
    };
    service.permissionRequested("/a", request);
    assert.equal((await service.get(w.workId)).work?.waiting?.requestId, "r-1");
    assert.equal((await service.list({})).active[0]?.status, "waiting");
    assert.equal((await new WorkStore(root).get(w.workId))?.status, "running");
    assert.doesNotMatch(JSON.stringify((await service.get(w.workId)).work), /secret/);
    const other = new WorkService({ ...options, instanceId: "instance-2" });
    t.after(async () => {
        other.stop();
    });
    assert.equal((await other.get(w.workId)).work?.waiting, undefined);
    service.permissionResolved("/a", "r-1");
    assert.equal((await service.get(w.workId)).work?.status, "running");
});

it("restores waiting when answer admission is busy and fails an admitted continuation honestly", async (t) => {
    const { service } = await rig(t);
    const w = await service.controller.startScheduled({
        jobId: "j",
        title: "A",
        sourceEventId: "j:retry",
        workspace: "/a",
        sessionId: "s",
    });
    const waiting = resolveWaitingInteraction(waitingMessage(), "s");
    assert.ok(waiting);
    await service.controller.waitForInput(w.workId, waiting);
    const before = await service.store.get(w.workId);
    const busy = Object.assign(new Error("busy"), { _tag: "LaneBusy" });
    await assert.rejects(
        service.answerWaiting({ workspace: "/a", sessionId: "s" }, "q-1", async () => {
            throw busy;
        }),
        /busy/,
    );
    const after = await service.store.get(w.workId);
    assert.equal(after?.status, "waiting");
    assert.equal(after?.attempt.attemptId, before?.attempt.attemptId);
    await assert.rejects(
        service.answerWaiting({ workspace: "/a", sessionId: "s" }, "q-1", async () => {
            throw new Error("provider failed");
        }),
        /provider failed/,
    );
    assert.equal((await service.get(w.workId)).work?.status, "failed");
});

it("does not prevent an answer from running when Work storage cannot be read", async (t) => {
    const { service } = await rig(t);
    service.store.list = async () => {
        throw new Error("store unavailable");
    };
    let runs = 0;
    const result = await service.answerWaiting(
        { workspace: "/a", sessionId: "s" },
        "q-1",
        async () => {
            runs++;
            return answer;
        },
    );
    assert.equal(runs, 1);
    assert.equal(result, answer);
});

it("wires real broker requested/resolved events to the projection without granting permissions", async (t) => {
    const { service } = await rig(t);
    const { PermissionBroker } = await import("../../src/permissions/permissionBroker.ts");
    const { wirePermissionPush } = await import("../../src/server/permissionPushAdapter.ts");
    const w = await service.controller.startScheduled({
        jobId: "j",
        title: "Run",
        sourceEventId: "j:broker",
        workspace: "/a",
        sessionId: "s",
    });
    const broker = new PermissionBroker(() => ({ mode: "ask", allow: [], deny: [] }));
    const frames: Record<string, unknown>[] = [];
    const unwire = wirePermissionPush({
        broker,
        workspace: "/a" as never,
        work: service,
        push: (_method, _session, params) => {
            frames.push(params);
        },
        notice: (kind) => kind,
    });
    t.after(async () => {
        broker.cleanupAll();
        unwire();
    });
    const decision = broker.requestConfigApproval({
        sessionId: "s",
        toolCallId: "config",
        fields: ["customProviders"],
    });
    const requestId = String(frames[0]?.requestId);
    assert.equal((await service.get(w.workId)).work?.waiting?.requestId, requestId);
    assert.ok(broker.getRequest(requestId), "observing a request must not resolve it");
    broker.resolve(requestId, false, "once");
    assert.equal((await decision).approved, false);
    assert.equal((await service.get(w.workId)).work?.waiting, undefined);
    assert.equal(frames.length, 2);
});

it("rewrites a legacy physical IM workspace key to the route key at startup", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "taco-work-legacy-im-"));
    const route = { channelId: "wechat-1", peerId: "peer", chatId: "chat" };
    const service = new WorkService({
        root,
        instanceId: "i",
        channels: {
            sendText: async () => ({ kind: "confirmed" as const }),
            maxMessageLength: () => 2000,
        },
        resolveRoute: () => route,
    });
    t.after(async () => {
        service.stop();
        await rm(root, { recursive: true, force: true });
    });
    const work = await service.controller.start({
        sourceEventId: "legacy-im",
        workspace: "/tmp/old-scratch",
        parentSessionId: "s",
        childSessionId: "c",
        agentType: "e",
        title: "legacy",
    });
    await service.start();
    assert.equal((await service.store.get(work.workId))?.workspace, "im://wechat-1/peer/chat");
});

it("marks a missing target during startup reconciliation but preserves unknown targets", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "taco-work-targets-"));
    const service = new WorkService({
        root,
        instanceId: "i",
        channels: {
            sendText: async () => ({ kind: "confirmed" as const }),
            maxMessageLength: () => 2000,
        },
        resolveRoute: () => undefined,
        resolveTargetState: async (workspace) => (workspace === "/gone" ? "missing" : "unknown"),
    });
    t.after(async () => {
        service.stop();
        await rm(root, { recursive: true, force: true });
    });
    const gone = await service.controller.start({
        sourceEventId: "gone",
        workspace: "/gone",
        parentSessionId: "s",
        childSessionId: "c1",
        agentType: "e",
        title: "gone",
    });
    const unknown = await service.controller.start({
        sourceEventId: "unknown",
        workspace: "/unknown",
        parentSessionId: "s",
        childSessionId: "c2",
        agentType: "e",
        title: "unknown",
    });
    await service.start();
    assert.equal((await service.store.get(gone.workId))?.sessionState, "deleted");
    assert.equal((await service.store.get(unknown.workId))?.sessionState, undefined);
});
