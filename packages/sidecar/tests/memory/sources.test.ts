import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { LocalMemoryStore } from "../../src/memory/local/store.ts";
import { buildLayeredMemoryBlock, resolveMemorySources } from "../../src/memory/sources.ts";
import type { MemoryEntry } from "../../src/memory/types.ts";

function entry(id: string, content: string): MemoryEntry {
    return {
        id,
        name: id,
        description: `${id} description`,
        type: "project",
        content,
        createdAt: "2026-11-10T00:00:00.000Z",
    };
}

describe("memory sources", () => {
    let home: string;
    let previousHome: string | undefined;

    beforeEach(() => {
        previousHome = process.env.TACO_HOME;
        home = mkdtempSync(join(tmpdir(), "taco-memory-sources-"));
        process.env.TACO_HOME = home;
    });

    afterEach(() => {
        if (previousHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
    });

    it("automatically adds associated workspace memory to an IM channel", async () => {
        const current = new LocalMemoryStore();
        current.initialize("im://wechat/peer/chat");
        await current.appendEntry(entry("channel-note", "channel"));

        const associatedRoot = join(home, "projects", "taco");
        const associated = new LocalMemoryStore();
        associated.initialize(associatedRoot);
        await associated.appendEntry(entry("workspace-note", "workspace"));

        const sources = resolveMemorySources({
            store: current,
            target: "channel",
            associatedRoots: [associatedRoot],
            inheritManagedGlobal: false,
        });

        assert.deepEqual(
            sources.current.map((topic) => topic.id),
            ["channel-note"],
        );
        assert.equal(sources.associatedWorkspaces.length, 1);
        assert.equal(sources.associatedWorkspaces[0]?.key, associatedRoot);
        assert.deepEqual(
            sources.associatedWorkspaces[0]?.entries.map((topic) => topic.id),
            ["workspace-note"],
        );
        assert.deepEqual(sources.managedGlobal, []);
    });

    it("inherits only explicit workspace sources after the channel opts in", async () => {
        const current = new LocalMemoryStore();
        current.initialize("im://wechat/peer/chat");
        await current.appendEntry(entry("channel-note", "channel"));

        const associatedRoot = join(home, "projects", "taco");
        const associated = new LocalMemoryStore();
        associated.initialize(associatedRoot);
        await associated.appendEntry(entry("workspace-note", "workspace"));

        const otherRoot = join(home, "projects", "other");
        const other = new LocalMemoryStore();
        other.initialize(otherRoot);
        await other.appendEntry(entry("managed-note", "managed"));

        const otherChannel = new LocalMemoryStore();
        otherChannel.initialize(join(home, "im", "channel-b", "scratch"));
        await otherChannel.appendEntry(entry("private-channel-note", "private"));
        const unknown = new LocalMemoryStore();
        unknown.initialize(join(home, "unknown-project"));
        await unknown.appendEntry(entry("unregistered-note", "unknown"));

        const disabled = resolveMemorySources({
            store: current,
            target: "channel",
            associatedRoots: [associatedRoot],
            inheritManagedGlobal: false,
        });
        assert.deepEqual(disabled.managedGlobal, []);

        const enabled = resolveMemorySources({
            store: current,
            target: "channel",
            associatedRoots: [associatedRoot],
            inheritManagedGlobal: true,
            managedGlobalRoots: [otherRoot, associatedRoot, otherRoot],
        });
        assert.equal(enabled.managedGlobal.length, 1);
        assert.equal(enabled.managedGlobal[0]?.key, otherRoot);
        assert.equal(enabled.managedGlobal[0]?.label, "other");
        const block = buildLayeredMemoryBlock(enabled);
        assert.match(block, /Taco system memory \(other\)/);
        assert.doesNotMatch(block, /private-channel-note|unregistered-note/);
        assert.deepEqual(
            enabled.managedGlobal[0]?.entries.map((topic) => topic.id),
            ["managed-note"],
        );
    });

    it("reuses inherited topic caches and refreshes after an external edit", async () => {
        const current = new LocalMemoryStore();
        current.initialize(join(home, "im", "channel", "scratch"));
        const associatedRoot = join(home, "linked-workspace");
        const managedRoot = join(home, "managed-workspace");
        const associated = new LocalMemoryStore();
        associated.initialize(associatedRoot);
        const managed = new LocalMemoryStore();
        managed.initialize(managedRoot);
        await associated.appendEntry(entry("associated", "before"));
        await managed.appendEntry(entry("managed", "before"));
        const options = {
            store: current,
            target: "channel" as const,
            associatedRoots: [associatedRoot],
            inheritManagedGlobal: true,
            managedGlobalRoots: [managedRoot],
        };
        const first = resolveMemorySources(options);
        const second = resolveMemorySources(options);
        assert.equal(
            first.associatedWorkspaces[0]?.entries,
            second.associatedWorkspaces[0]?.entries,
        );
        assert.equal(first.managedGlobal[0]?.entries, second.managedGlobal[0]?.entries);
        const path = join(managed.topicDir, "managed.md");
        writeFileSync(
            path,
            "---\nname: Updated\ndescription: Changed externally\ntype: project\n---\n\nlonger content",
        );
        assert.equal(resolveMemorySources(options).managedGlobal[0]?.entries[0]?.name, "Updated");
        assert.deepEqual(
            resolveMemorySources({ ...options, managedGlobalRoots: [] }).managedGlobal,
            [],
        );
        assert.deepEqual(
            resolveMemorySources({ ...options, associatedRoots: [] }).associatedWorkspaces,
            [],
        );
    });

    it("bounds topic count across all layers while retaining human memory", () => {
        const block = buildLayeredMemoryBlock({
            target: "channel",
            memoryContent: "Human instructions",
            current: Array.from({ length: 70 }, (_, i) => entry(`current-${i}`, "")),
            associatedWorkspaces: [
                {
                    key: "/linked",
                    label: "Linked",
                    entries: Array.from({ length: 70 }, (_, i) => entry(`linked-${i}`, "")),
                },
            ],
            managedGlobal: Array.from({ length: 50 }, (_, i) => ({
                key: `/project-${i}`,
                label: `Project ${i}`,
                entries: [entry(`managed-${i}`, "")],
            })),
        });
        assert.equal(block.match(/^- \[/gm)?.length, 100);
        assert.match(block, /Human instructions/);
        assert.match(block, /omitted/i);
    });

    it("bounds the combined topic bytes for multibyte names and descriptions", () => {
        const memoryContent = "Human instructions";
        const block = buildLayeredMemoryBlock({
            target: "channel",
            memoryContent,
            current: [],
            associatedWorkspaces: Array.from({ length: 100 }, (_, i) => ({
                key: `/project-${i}`,
                label: `Project ${i}`,
                entries: [
                    {
                        ...entry(`topic-${i}`, ""),
                        name: "界".repeat(160),
                        description: "界".repeat(80),
                    },
                ],
            })),
            managedGlobal: [],
        });
        assert.ok(Buffer.byteLength(block) <= Buffer.byteLength(memoryContent) + 32768);
        assert.ok((block.match(/^- \[/gm)?.length ?? 0) > 0);
        assert.match(block, /omitted/i);
    });

    it("includes inherited topics after empty layers in newest-first order", () => {
        const block = buildLayeredMemoryBlock({
            target: "channel",
            memoryContent: "# Memory",
            current: [],
            associatedWorkspaces: [
                { key: "/empty", label: "Empty", entries: [] },
                {
                    key: "/linked",
                    label: "Linked",
                    entries: [
                        entry("older", ""),
                        { ...entry("newer", ""), updatedAt: "2026-11-11T00:00:00.000Z" },
                    ],
                },
            ],
            managedGlobal: [{ key: "/global", label: "Global", entries: [entry("global", "")] }],
        });
        assert.equal(block.match(/^- \[/gm)?.length, 3);
        assert.ok(block.indexOf("— newer") < block.indexOf("— older"));
        assert.match(block, /Associated workspace memory \(Linked\).*read-only/);
        assert.match(block, /Taco system memory \(Global\).*read-only/);
        assert.doesNotMatch(block, /Current channel memory|\(Empty\)|omitted/i);
    });

    it("keeps large human memory outside the topic budget", () => {
        const memoryContent = `Human instructions\n${"人工指引".repeat(4000)}`;
        const block = buildLayeredMemoryBlock({
            target: "workspace",
            memoryContent,
            current: Array.from({ length: 100 }, (_, i) => ({
                ...entry(`topic-${i}`, ""),
                name: "界".repeat(160),
                description: "述".repeat(80),
            })),
            associatedWorkspaces: [],
            managedGlobal: [],
        });
        assert.ok(block.startsWith(memoryContent));
        assert.ok(Buffer.byteLength(block) - Buffer.byteLength(memoryContent) <= 32 * 1024);
        assert.ok((block.match(/^- \[/gm)?.length ?? 0) > 0);
        assert.match(block, /omitted/i);
    });

    it("disambiguates workspace names without exposing absolute paths", async () => {
        const current = new LocalMemoryStore();
        current.initialize(join(home, "im", "channel", "scratch"));
        const roots = [join(home, "a", "project"), join(home, "b", "project")];
        for (const root of roots) {
            const store = new LocalMemoryStore();
            store.initialize(root);
            await store.appendEntry(entry("note", ""));
        }
        const sources = resolveMemorySources({
            store: current,
            target: "channel",
            associatedRoots: [],
            inheritManagedGlobal: true,
            managedGlobalRoots: roots,
        });
        assert.equal(new Set(sources.managedGlobal.map((layer) => layer.label)).size, 2);
        assert.ok(sources.managedGlobal.every((layer) => layer.label.includes("project")));
        assert.doesNotMatch(buildLayeredMemoryBlock(sources), new RegExp(home));
    });

    it("labels each inherited layer in the model context", async () => {
        const current = new LocalMemoryStore();
        current.initialize("im://wechat/peer/chat");
        await current.appendEntry(entry("channel-note", "channel"));

        const associatedRoot = join(home, "projects", "taco");
        const associated = new LocalMemoryStore();
        associated.initialize(associatedRoot);
        await associated.appendEntry(entry("workspace-note", "workspace"));

        const block = buildLayeredMemoryBlock(
            resolveMemorySources({
                store: current,
                target: "channel",
                associatedRoots: [associatedRoot],
                inheritManagedGlobal: false,
            }),
        );

        assert.match(block, /Current channel memory/);
        assert.match(block, /Associated workspace memory \(taco\)/);
        assert.doesNotMatch(
            block,
            new RegExp(associatedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
        assert.match(block, /channel-note/);
        assert.match(block, /workspace-note/);
    });
});
