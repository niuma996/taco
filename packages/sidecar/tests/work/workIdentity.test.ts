/**
 * Work identity across workspaces: a Work is addressed by the composite of
 * its workspace and its source event, so two projects can hold the same
 * session id without sharing records. Records written before ids carried the
 * workspace stay addressable — by their original id everywhere, and by the id
 * a replay computes today at the dedup check.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ImRoute } from "@taco-ai/protocol";
import { asSessionId, makeImCwd } from "@taco-ai/protocol";
import { sourceEventIdFor, WorkService } from "../../src/work/workService.ts";
import { legacyWorkIdForSource, workIdForSource } from "../../src/work/workStore.ts";
import { WORK_SCHEMA_VERSION, type WorkRecord } from "../../src/work/workTypes.ts";

const channels = {
    sendText: async () => ({ kind: "confirmed" as const }),
    maxMessageLength: () => 1000,
    getDeliveryBinding: () => "binding-1",
};

async function withService(
    t: import("node:test").TestContext,
    run: (service: WorkService, root: string) => Promise<void>,
    resolveRoute: (sessionId: string, workspace?: string) => ImRoute | undefined = () => undefined,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "taco-work-identity-"));
    const service = new WorkService({ root, instanceId: "i", channels, resolveRoute });
    t.after(async () => {
        service.stop();
        await rm(root, { recursive: true, force: true });
    });
    await run(service, root);
}

function legacyRecord(sourceEventId: string, workspace?: string): WorkRecord {
    return {
        schemaVersion: WORK_SCHEMA_VERSION,
        workId: legacyWorkIdForSource(sourceEventId),
        revision: 0,
        kind: "subagent",
        title: "old",
        sourceEventId,
        ...(workspace === undefined ? {} : { workspace }),
        parentSessionId: "p",
        childSessionId: "c",
        agentType: "e",
        status: "running",
        ownerInstanceId: "i",
        createdAt: 1,
        updatedAt: 1,
        attempt: { attemptId: "att-1", startedAt: 1 },
    };
}

it("separates same-sessionId launches across workspaces", async (t) => {
    await withService(t, async (service) => {
        const parent = asSessionId("shared-parent");
        const a = await service.onLaunch({
            workspace: "/ws/a",
            parentSessionId: parent,
            parentToolCallId: "tc-1",
            childSessionId: asSessionId("child-a"),
            agentType: "e",
        });
        const b = await service.onLaunch({
            workspace: "/ws/b",
            parentSessionId: parent,
            parentToolCallId: "tc-1",
            childSessionId: asSessionId("child-b"),
            agentType: "e",
        });
        assert.ok(a && b);
        assert.notEqual(a, b);
        assert.equal((await service.store.list()).length, 2);
        assert.equal(service.workIdFor(parent, "tc-1", "/ws/a"), a);
        assert.equal(service.workIdFor(parent, "tc-1", "/ws/b"), b);
        // The pre-workspace id is ambiguous once both scoped records exist;
        // it must never select one project arbitrarily.
        assert.equal(
            await service.store.resolveId(
                legacyWorkIdForSource(sourceEventIdFor("shared-parent", "tc-1")),
            ),
            undefined,
        );
        assert.deepEqual(
            await service.beginParentNotice(
                legacyWorkIdForSource(sourceEventIdFor("shared-parent", "tc-1")),
                false,
            ),
            { mode: "skip" },
        );

        // Recovery by child session is scoped: the other workspace cannot see it.
        assert.equal(
            (await service.store.findByChildSessionId("child-a", "/ws/b"))?.workId,
            undefined,
        );
        assert.equal((await service.store.findByChildSessionId("child-a", "/ws/a"))?.workId, a);

        // Settling one leaves the other running.
        await service.onSettle(a, parent, {
            outcome: "completed",
            resultText: "done",
            partial: false,
        });
        assert.equal((await service.store.get(a))?.status, "completed");
        assert.equal((await service.store.get(b))?.status, "running");
    });
});

it("adopts a pre-workspace record on replay instead of duplicating it", async (t) => {
    await withService(t, async (service) => {
        const source = sourceEventIdFor("p", "tc");
        const seeded = await service.store.createIfAbsent(legacyRecord(source, "/ws/a"));
        assert.equal(seeded.created, true);

        const workId = await service.onLaunch({
            workspace: "/ws/a",
            parentSessionId: asSessionId("p"),
            parentToolCallId: "tc",
            childSessionId: asSessionId("c"),
            agentType: "e",
        });
        assert.equal(workId, seeded.record.workId);
        assert.equal((await service.store.list()).length, 1);

        // Both the stored id and the composite id a caller computes today resolve.
        const composite = workIdForSource(source, "/ws/a");
        assert.notEqual(composite, workId);
        assert.ok(workId);
        assert.equal((await service.get(workId)).work?.workId, workId);
        assert.equal((await service.get(composite)).work?.workId, workId);

        // The parent-notice claim also resolves the composite id.
        await service.controller.settle({
            workId,
            outcome: "completed",
            resultText: "answer",
            parentWillReply: false,
        });
        const claim = await service.beginParentNotice(composite);
        assert.equal(claim.mode, "silent");
        assert.ok(claim.claimId);

        // Cancel, retry and delete accept the composite id too.
        assert.equal((await service.retryDelivery(composite)).outcome, "not_retryable");
        assert.equal((await service.delete(composite)).outcome, "deleted");
        assert.equal(await service.store.get(workId), undefined);
    });
});

it("does not adopt an old record from another or unknown workspace", async (t) => {
    await withService(t, async (service) => {
        const source = sourceEventIdFor("p", "tc");
        await service.store.createIfAbsent(legacyRecord(source, "/ws/a"));

        const otherWorkspace = await service.onLaunch({
            workspace: "/ws/b",
            parentSessionId: asSessionId("p"),
            parentToolCallId: "tc",
            childSessionId: asSessionId("c-b"),
            agentType: "e",
        });
        assert.equal(otherWorkspace, workIdForSource(source, "/ws/b"));
        assert.equal((await service.store.list()).length, 2);

        const unknownSource = sourceEventIdFor("p-unknown", "tc");
        await service.store.createIfAbsent(legacyRecord(unknownSource));
        const scopedUnknown = await service.onLaunch({
            workspace: "/ws/b",
            parentSessionId: asSessionId("p-unknown"),
            parentToolCallId: "tc",
            childSessionId: asSessionId("c-unknown"),
            agentType: "e",
        });
        assert.equal(scopedUnknown, workIdForSource(unknownSource, "/ws/b"));
        assert.equal((await service.store.list()).length, 4);
    });
});

it("does not claim a legacy notification from another or unknown workspace", async (t) => {
    await withService(t, async (service) => {
        const old = {
            ...legacyRecord(sourceEventIdFor("p", "tc"), "/ws/a"),
            status: "completed" as const,
        };
        await service.store.createIfAbsent(old);
        assert.deepEqual(
            await service.beginParentNotice(old.workId, true, {
                workspace: "/ws/b",
                sessionId: "p",
            }),
            { mode: "skip" },
        );
        assert.equal((await service.store.get(old.workId))?.parentNotice, undefined);
        const unknown = {
            ...legacyRecord(sourceEventIdFor("p", "unknown")),
            status: "completed" as const,
        };
        await service.store.createIfAbsent(unknown);
        assert.deepEqual(
            await service.beginParentNotice(unknown.workId, true, {
                workspace: "/ws/a",
                sessionId: "p",
            }),
            { mode: "skip" },
        );
    });
});

it("keeps alias controls and tombstones scoped across restart", async (t) => {
    await withService(t, async (service, root) => {
        const source = sourceEventIdFor("p", "tc");
        const old = legacyWorkIdForSource(source);
        const scoped = await service.controller.start({
            sourceEventId: source,
            workspace: "/ws/a",
            parentSessionId: "p",
            childSessionId: "shared-child",
            agentType: "e",
            title: "a",
        });
        await service.controller.waitForInput(
            scoped.workId,
            { sessionId: "shared-child", toolCallId: "q", toolName: "askUser" },
            scoped.attempt.attemptId,
        );
        assert.equal((await service.get(old)).work?.workId, scoped.workId);
        assert.equal((await service.cancel(old, "other-attempt")).outcome, "attempt_mismatch");
        assert.equal((await service.cancel(old, scoped.attempt.attemptId)).outcome, "accepted");
        assert.equal((await service.retryDelivery(old)).outcome, "not_retryable");
        assert.equal((await service.delete(old)).outcome, "deleted");
        const restarted = new WorkService({
            root,
            instanceId: "i2",
            channels,
            resolveRoute: () => undefined,
        });
        t.after(() => restarted.stop());
        assert.equal((await restarted.get(old)).work, null);
        const b = await restarted.controller.start({
            sourceEventId: source,
            workspace: "/ws/b",
            parentSessionId: "p",
            childSessionId: "shared-child",
            agentType: "e",
            title: "b",
        });
        assert.notEqual(b.workId, scoped.workId);
        assert.equal((await restarted.get(old)).work, null);
        assert.equal((await restarted.cancel(old, b.attempt.attemptId)).outcome, "not_found");
        assert.equal((await restarted.store.get(b.workId))?.status, "running");
    });
});

it("honors historical tombstones that lack source and workspace attribution", async (t) => {
    await withService(t, async (service, root) => {
        const source = sourceEventIdFor("p", "tc");
        const old = legacyWorkIdForSource(source);
        await mkdir(join(root, "deleted"));
        await writeFile(
            join(root, "deleted", `${old}.json`),
            JSON.stringify({ workId: old, deletedAt: 1 }),
        );
        assert.equal(
            await service.onLaunch({
                workspace: "/ws/a",
                parentSessionId: asSessionId("p"),
                parentToolCallId: "tc",
                childSessionId: asSessionId("c"),
                agentType: "e",
            }),
            undefined,
        );
        assert.equal((await service.store.list()).length, 0);
        assert.deepEqual(
            await service.beginParentNotice(
                workIdForSource(source, "/ws/a"),
                false,
                { workspace: "/ws/a", sessionId: "p" },
                old,
            ),
            { mode: "skip" },
        );
    });
});

it("returns the canonical id for every hook in an aliased parent notice", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "taco-work-identity-"));
    const calls: { sessionId: string; workspace?: string }[] = [];
    const service = new WorkService({
        root,
        instanceId: "i",
        channels,
        resolveRoute: (sessionId, workspace) => {
            calls.push({ sessionId, workspace });
            return workspace === "/ws/a"
                ? { channelId: "chan", peerId: "peer", chatId: "chat" }
                : undefined;
        },
    });
    t.after(async () => {
        service.stop();
        await rm(root, { recursive: true, force: true });
    });

    const source = sourceEventIdFor("p-notice", "tc");
    const seeded = await service.store.createIfAbsent(legacyRecord(source, "/ws/a"));
    const legacyId = seeded.record.workId;
    await service.controller.settle({
        workId: legacyId,
        attemptId: "att-1",
        outcome: "completed",
        resultText: "answer",
        deliverTo: { channelId: "chan", peerId: "peer", chatId: "chat", bindingId: "binding-1" },
        parentWillReply: true,
    });
    const composite = workIdForSource(source, "/ws/a");
    const decision = await service.beginParentNotice(composite);
    assert.equal(decision.mode, "capture");
    assert.ok(decision.claimId);
    assert.equal(decision.workId, legacyId);

    const noticeId = decision.workId ?? composite;
    service.onNoticeRunStart(noticeId, asSessionId("p-notice"));
    assert.equal(service.controller.isCapturing(legacyId), true);
    assert.equal(service.controller.isCapturing(composite), false);
    service.onNoticeRunRelease(noticeId, asSessionId("p-notice"));

    await service.endParentNotice(composite, decision.claimId, {
        status: "completed",
        reply: "reply",
    });
    await service.deliverer.forget(legacyId);
    assert.equal((await service.store.get(legacyId))?.status, "completed");
    assert.equal((await service.get(composite)).resultText, "answer");
});

it("isolates notice reply holds when session ids match across workspaces", async (t) => {
    await withService(t, async (service) => {
        service.onNoticeRunStart("w-a", asSessionId("shared"), "/ws/a");
        assert.equal(service.controller.isHoldingReplies("shared", "/ws/a"), true);
        assert.equal(service.controller.isHoldingReplies("shared", "/ws/b"), false);
        service.onNoticeRunRelease("w-a", asSessionId("shared"));
        assert.equal(service.controller.isHoldingReplies("shared", "/ws/a"), false);
    });
});

it("serializes concurrent legacy and composite creation for the same workspace", async (t) => {
    await withService(t, async (service) => {
        const legacy = legacyRecord(sourceEventIdFor("p-race", "tc"), "/ws/a");
        const composite = { ...legacy, workId: workIdForSource(legacy.sourceEventId, "/ws/a") };
        const results = await Promise.all([
            service.store.createIfAbsent(legacy),
            service.store.createIfAbsent(composite, legacy.workId),
        ]);
        assert.equal(results.filter((result) => result.created).length, 1);
        assert.equal(results[0].record.workId, results[1].record.workId);
        assert.equal((await service.store.list()).length, 1);
    });
});

it("keeps a deleted old id from retargeting another workspace", async (t) => {
    await withService(t, async (service) => {
        const source = sourceEventIdFor("p", "tc");
        const legacy = legacyRecord(source, "/ws/a");
        await service.store.createIfAbsent(legacy);
        const b = { ...legacy, workspace: "/ws/b", workId: workIdForSource(source, "/ws/b") };
        await service.store.createIfAbsent(b);
        await service.controller.settle({
            workId: legacy.workId,
            outcome: "completed",
            resultText: "a",
            parentWillReply: false,
        });
        assert.equal((await service.delete(legacy.workId)).outcome, "deleted");
        assert.equal((await service.get(legacy.workId)).work, null);
        assert.deepEqual(await service.beginParentNotice(workIdForSource(source, "/ws/a"), false), {
            mode: "skip",
        });
        assert.equal((await service.store.get(b.workId))?.status, "running");
    });
});

it("does not migrate a known workspace from a bare session-id route on restart", async (t) => {
    await withService(
        t,
        async (service) => {
            const launch = {
                workspace: "/ws/a",
                parentSessionId: asSessionId("p"),
                parentToolCallId: "tc",
                childSessionId: asSessionId("c"),
                agentType: "e",
            };
            const id = await service.onLaunch(launch);
            assert.ok(id);
            await service.start();
            assert.equal((await service.store.get(id))?.workspace, "/ws/a");
        },
        (_session, workspace) =>
            workspace === undefined
                ? { channelId: "chan", peerId: "peer", chatId: "chat" }
                : undefined,
    );
});

it("keeps a deleted legacy source deleted when replayed under a composite id", async (t) => {
    await withService(t, async (service) => {
        const source = sourceEventIdFor("p", "tc");
        const { record } = await service.store.createIfAbsent(legacyRecord(source, "/ws/a"));
        await service.controller.settle({
            workId: record.workId,
            outcome: "completed",
            resultText: "answer",
            parentWillReply: false,
        });
        assert.equal((await service.delete(record.workId)).outcome, "deleted");

        const replayed = await service.onLaunch({
            workspace: "/ws/a",
            parentSessionId: asSessionId("p"),
            parentToolCallId: "tc",
            childSessionId: asSessionId("c2"),
            agentType: "e",
        });
        assert.equal(replayed, undefined);
        assert.equal((await service.store.list()).length, 0);
    });
});

it("addresses a record without workspace attribution by its plain source id only", async (t) => {
    await withService(t, async (service) => {
        const workId = await service.onLaunch({
            parentSessionId: asSessionId("p"),
            parentToolCallId: "tc",
            childSessionId: asSessionId("c"),
            agentType: "e",
        });
        assert.equal(workId, legacyWorkIdForSource(sourceEventIdFor("p", "tc")));
        assert.ok(workId);
        assert.equal(await service.store.resolveId(workId), workId);
        // A composite id computed with some workspace never steals this record.
        assert.equal(
            await service.store.resolveId(
                workIdForSource(sourceEventIdFor("p", "tc"), "/ws/other"),
            ),
            undefined,
        );
        assert.equal((await service.get(workId)).work?.workId, workId);
    });
});

it("routes delivery by workspace when the workspace is known", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "taco-work-identity-"));
    const calls: { sessionId: string; workspace?: string }[] = [];
    const imWorkspace = makeImCwd("chan", "peer", "chat");
    const service = new WorkService({
        root,
        instanceId: "i",
        channels,
        resolveRoute: (sessionId, workspace) => {
            calls.push({ sessionId, workspace });
            return workspace === imWorkspace
                ? { channelId: "chan", peerId: "peer", chatId: "chat" }
                : undefined;
        },
    });
    t.after(async () => {
        service.stop();
        await rm(root, { recursive: true, force: true });
    });

    const parent = asSessionId("p-im");
    const workId = await service.onLaunch({
        workspace: imWorkspace,
        parentSessionId: parent,
        parentToolCallId: "tc",
        childSessionId: asSessionId("c"),
        agentType: "e",
    });
    assert.ok(workId);
    assert.deepEqual(calls.at(-1), { sessionId: "p-im", workspace: imWorkspace });
    assert.deepEqual((await service.store.get(workId))?.deliveryTarget, {
        channelId: "chan",
        peerId: "peer",
        chatId: "chat",
        bindingId: "binding-1",
    });

    await service.onSettle(workId, parent, {
        outcome: "completed",
        resultText: "done",
        partial: false,
    });
    assert.deepEqual(calls.at(-1), { sessionId: "p-im", workspace: imWorkspace });

    // A plain filesystem workspace never degrades to a bare session-id lookup.
    await service.onLaunch({
        workspace: "/ws/plain",
        parentSessionId: asSessionId("p-plain"),
        parentToolCallId: "tc",
        childSessionId: asSessionId("c2"),
        agentType: "e",
    });
    assert.deepEqual(calls.at(-1), { sessionId: "p-plain", workspace: "/ws/plain" });
});
