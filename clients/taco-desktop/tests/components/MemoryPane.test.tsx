/**
 * MemoryPane — view component tests.
 * No sidecar/RPC dependencies; all callbacks are vi.fn() fakes.
 */

import { strict as assert } from "node:assert";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_ROOT_ID } from "../../src/lib/memoryPaneTypes";
import { MemoryPane } from "../../src/views/MemoryPane";

// Mock react-i18next at module level so every t() call gets a fresh identity translator.
vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({
        t: (key: string) => key,
        i18n: { language: "en" },
    })),
}));

const sampleData = {
    enabled: true,
    memoryContent: "# Memory\n\n## [2026-07-29] user\n\ntest",
    memoryHash: "abc123",
    topics: [
        {
            id: "user_role",
            name: "User uses pnpm",
            description: "Project uses pnpm",
            type: "user" as const,
            content: "User said pnpm.",
            createdAt: "2026-07-29T00:00:00.000Z",
        },
    ],
};

describe("MemoryPane", () => {
    afterEach(cleanup);

    it("shows disabled state when enabled=false", () => {
        const { container } = render(
            <MemoryPane
                data={{ ...sampleData, enabled: false, memoryContent: "", topics: [] }}
                loading={false}
                error={null}
                selectedId={MEMORY_ROOT_ID}
                onSelect={() => {}}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => {}}
                onRefresh={() => {}}
                saving={false}
            />,
        );
        expect(within(container).getByText("memory.disabledState")).toBeTruthy();
    });

    it("shows empty state when memory only has header and no topics", () => {
        const { container } = render(
            <MemoryPane
                data={{ ...sampleData, memoryContent: "# Memory\n", topics: [] }}
                loading={false}
                error={null}
                selectedId={MEMORY_ROOT_ID}
                onSelect={() => {}}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => {}}
                onRefresh={() => {}}
                saving={false}
            />,
        );
        expect(within(container).getByText("memory.emptyState")).toBeTruthy();
    });

    it("keeps the MEMORY.md heading in both the preview and markdown reading view", () => {
        const { container } = render(
            <MemoryPane
                data={sampleData}
                loading={false}
                error={null}
                selectedId={MEMORY_ROOT_ID}
                onSelect={() => {}}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => {}}
                onRefresh={() => {}}
                saving={false}
            />,
        );

        expect(container.querySelector(".memory-global-card")?.textContent).toContain("# Memory");
        expect(screen.getByRole("heading", { name: "Memory", level: 1 })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "[2026-07-29] user", level: 2 })).toBeTruthy();
    });

    it("enters edit mode on edit click and calls onSaveMemory with draft and hash", async () => {
        const onSaveMemory = vi.fn().mockResolvedValue({ ok: true });
        const { container } = render(
            <MemoryPane
                data={sampleData}
                loading={false}
                error={null}
                selectedId={MEMORY_ROOT_ID}
                onSelect={() => {}}
                onSaveMemory={onSaveMemory}
                onDeleteTopic={async () => {}}
                onRefresh={() => {}}
                saving={false}
            />,
        );
        const ui = within(container);
        fireEvent.click(ui.getByText("memory.edit"));
        const textarea = ui.getByRole("textbox") as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: "# Memory\n\nedited" } });
        fireEvent.click(ui.getByText("memory.save"));
        await waitFor(() => expect(onSaveMemory).toHaveBeenCalled());
        assert.equal(onSaveMemory.mock.calls[0]?.[0], "# Memory\n\nedited");
        assert.equal(onSaveMemory.mock.calls[0]?.[1], "abc123");
    });

    it("does NOT overwrite draft when external data refresh fires while editing", () => {
        const { container, rerender } = render(
            <MemoryPane
                data={sampleData}
                loading={false}
                error={null}
                selectedId={MEMORY_ROOT_ID}
                onSelect={() => {}}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => {}}
                onRefresh={() => {}}
                saving={false}
            />,
        );
        const ui = within(container);
        fireEvent.click(ui.getByText("memory.edit"));
        const textarea = ui.getByRole("textbox") as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: "my draft" } });

        // Simulate an external refresh: memoryContent changed — use rerender
        // (same component instance, React preserves state).
        rerender(
            <MemoryPane
                data={{ ...sampleData, memoryContent: "# Memory\n\nrefreshed" }}
                loading={false}
                error={null}
                selectedId={MEMORY_ROOT_ID}
                onSelect={() => {}}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => {}}
                onRefresh={() => {}}
                saving={false}
            />,
        );

        assert.equal((ui.getByRole("textbox") as HTMLTextAreaElement).value, "my draft");
    });

    it("shows conflict dialog on MemoryConflictPayload and overwrite retries with new hash", async () => {
        const onSaveMemory = vi
            .fn()
            .mockResolvedValueOnce({
                ok: false,
                conflict: { currentContent: "from-disk", currentHash: "newHash" },
            })
            .mockResolvedValueOnce({ ok: true });

        const { container } = render(
            <MemoryPane
                data={sampleData}
                loading={false}
                error={null}
                selectedId={MEMORY_ROOT_ID}
                onSelect={() => {}}
                onSaveMemory={onSaveMemory}
                onDeleteTopic={async () => {}}
                onRefresh={() => {}}
                saving={false}
            />,
        );
        const ui = within(container);
        fireEvent.click(ui.getByText("memory.edit"));
        const textarea = ui.getByRole("textbox") as HTMLTextAreaElement;
        // Trigger a change so the save button (disabled={draft === data.memoryContent}) becomes enabled.
        fireEvent.change(textarea, { target: { value: "# Memory\n\nconflict" } });
        fireEvent.click(ui.getByText("memory.save"));
        // ConfirmModal renders via Radix Portal → use screen (queries document.body) not within(container).
        await waitFor(() => expect(screen.getByText("memory.conflictTitle")).toBeTruthy());

        fireEvent.click(screen.getByText("memory.overwriteMine"));
        await waitFor(() => expect(onSaveMemory).toHaveBeenCalledTimes(2));
        assert.equal(onSaveMemory.mock.calls[1]?.[1], "newHash");
    });

    it("discard button in conflict replaces draft with currentContent and stays editing", async () => {
        const onSaveMemory = vi.fn().mockResolvedValue({
            ok: false,
            conflict: { currentContent: "from-disk", currentHash: "newHash" },
        });
        const { container } = render(
            <MemoryPane
                data={sampleData}
                loading={false}
                error={null}
                selectedId={MEMORY_ROOT_ID}
                onSelect={() => {}}
                onSaveMemory={onSaveMemory}
                onDeleteTopic={async () => {}}
                onRefresh={() => {}}
                saving={false}
            />,
        );
        const ui = within(container);
        fireEvent.click(ui.getByText("memory.edit"));
        const textarea = ui.getByRole("textbox") as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: "# Memory\n\ndiscard" } });
        fireEvent.click(ui.getByText("memory.save"));
        await waitFor(() => screen.getByText("memory.conflictTitle"));
        fireEvent.click(screen.getByText("memory.discardMine"));
        assert.equal(textarea.value, "from-disk");
    });

    it("filters the list by type and keeps current topics under their source", () => {
        const now = new Date().toISOString();
        render(
            <MemoryPane
                data={{
                    ...sampleData,
                    topics: [
                        {
                            id: "recent_project",
                            name: "Recent project",
                            description: "fresh",
                            type: "project" as const,
                            content: "fresh content",
                            createdAt: now,
                        },
                        {
                            id: "old_user",
                            name: "Old user",
                            description: "old",
                            type: "user" as const,
                            content: "old content",
                            createdAt: "2026-01-01T00:00:00.000Z",
                        },
                    ],
                }}
                loading={false}
                error={null}
                selectedId={MEMORY_ROOT_ID}
                onSelect={() => {}}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => {}}
                onRefresh={() => {}}
                saving={false}
            />,
        );
        expect(screen.getByRole("tab", { name: "memory.layer.currentWorkspace" })).toBeTruthy();
        expect(screen.getByText("Recent project")).toBeTruthy();
        expect(screen.getByText("Old user")).toBeTruthy();

        fireEvent.click(screen.getByRole("radio", { name: "memory.type.project" }));
        expect(screen.getByText("Recent project")).toBeTruthy();
        expect(screen.queryByText("Old user")).toBeNull();
        expect(
            screen.getByRole("radio", { name: "memory.type.project" }).getAttribute("aria-checked"),
        ).toBe("true");

        // Arrow keys move the filter like a radio group.
        fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
        expect(
            screen
                .getByRole("radio", { name: "memory.type.reference" })
                .getAttribute("aria-checked"),
        ).toBe("true");
    });

    it("renders MEMORY.md separately and lays topics out in grouped card grids", () => {
        const now = new Date().toISOString();
        const { container } = render(
            <MemoryPane
                data={{
                    ...sampleData,
                    topics: [
                        {
                            id: "recent_one",
                            name: "Recent one",
                            description: "one",
                            type: "project" as const,
                            content: "one content",
                            createdAt: now,
                        },
                        {
                            id: "recent_two",
                            name: "Recent two",
                            description: "two",
                            type: "reference" as const,
                            content: "two content",
                            createdAt: now,
                        },
                    ],
                }}
                loading={false}
                error={null}
                selectedId={MEMORY_ROOT_ID}
                onSelect={() => {}}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => {}}
                onRefresh={() => {}}
                saving={false}
            />,
        );

        expect(container.querySelector(".memory-global-card")).toBeTruthy();
        expect(container.querySelector(".memory-global-card")?.textContent).toContain("test");
        const grids = container.querySelectorAll(".memory-card-grid");
        expect(grids).toHaveLength(1);
        expect(grids[0]?.querySelectorAll("[data-memory-row]")).toHaveLength(2);
    });

    it("arrow keys move the selection through the list", () => {
        const onSelect = vi.fn();
        render(
            <MemoryPane
                data={sampleData}
                loading={false}
                error={null}
                selectedId={MEMORY_ROOT_ID}
                onSelect={onSelect}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => true}
                onRefresh={() => {}}
                saving={false}
            />,
        );
        const globalRow = screen.getByRole("button", { name: "memory.globalName" });
        globalRow.focus();
        fireEvent.keyDown(globalRow, { key: "ArrowDown" });
        expect(onSelect).toHaveBeenLastCalledWith("user_role");
        fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
        expect(onSelect).toHaveBeenLastCalledWith(MEMORY_ROOT_ID);
    });

    it("search matches the topic content, not only its title", () => {
        const { container } = render(
            <MemoryPane
                data={sampleData}
                loading={false}
                error={null}
                selectedId={MEMORY_ROOT_ID}
                onSelect={() => {}}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => {}}
                onRefresh={() => {}}
                saving={false}
            />,
        );
        const ui = within(container);
        fireEvent.click(ui.getByRole("button", { name: "pane.searchLabel" }));
        fireEvent.change(ui.getByRole("textbox"), { target: { value: "said" } });
        expect(ui.getByText("User uses pnpm")).toBeTruthy();
    });

    it("opens delete confirm modal when topic delete clicked", async () => {
        const { container } = render(
            <MemoryPane
                data={sampleData}
                loading={false}
                error={null}
                selectedId="user_role"
                onSelect={() => {}}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => {}}
                onRefresh={() => {}}
                saving={false}
            />,
        );
        const ui = within(container);
        fireEvent.click(ui.getByText("memory.delete"));
        // ConfirmModal renders via Radix Portal → use screen.
        await waitFor(() => expect(screen.getByText("memory.deleteTopicTitle")).toBeTruthy());
    });

    it("shows updatedAt row when topic has been replaced", () => {
        render(
            <MemoryPane
                data={{
                    enabled: true,
                    memoryContent: "# Memory\n\n## [2026-07-29] user\n\ntest",
                    memoryHash: "abc123",
                    topics: [
                        {
                            id: "user_role",
                            name: "User uses pnpm",
                            description: "Project uses pnpm",
                            type: "user" as const,
                            content: "User said pnpm.",
                            createdAt: "2026-07-29T00:00:00.000Z",
                            updatedAt: "2026-07-30T00:00:00.000Z",
                        },
                    ],
                }}
                loading={false}
                error={null}
                selectedId="user_role"
                onSelect={() => {}}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => {}}
                onRefresh={() => {}}
                saving={false}
            />,
        );
        expect(screen.getByText("memory.updatedLabel")).toBeTruthy();
    });

    it("does not show updatedAt row when topic has never been updated", () => {
        render(
            <MemoryPane
                data={{
                    enabled: true,
                    memoryContent: "# Memory\n\n## [2026-07-29] user\n\ntest",
                    memoryHash: "abc123",
                    topics: [
                        {
                            id: "user_role",
                            name: "User uses pnpm",
                            description: "Project uses pnpm",
                            type: "user" as const,
                            content: "User said pnpm.",
                            createdAt: "2026-07-29T00:00:00.000Z",
                        },
                    ],
                }}
                loading={false}
                error={null}
                selectedId="user_role"
                onSelect={() => {}}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => {}}
                onRefresh={() => {}}
                saving={false}
            />,
        );
        expect(screen.queryByText("memory.updatedLabel")).toBeNull();
    });

    it("shows channel memory, associated workspace memory, and the disabled Taco layer", () => {
        render(
            <MemoryPane
                data={{
                    ...sampleData,
                    memorySources: {
                        target: "channel",
                        associatedWorkspaces: ["/repo/taco"],
                        managedGlobal: { enabled: false },
                    },
                    topics: [
                        {
                            ...sampleData.topics[0],
                            memoryLayer: "current",
                            memoryLayerKey: "im://wechat/peer/chat",
                            readOnly: false,
                        },
                        {
                            id: "workspace_role",
                            name: "Workspace role",
                            description: "Workspace memory",
                            type: "project" as const,
                            content: "Inherited from the associated workspace.",
                            createdAt: "2026-07-29T00:00:00.000Z",
                            memoryLayer: "workspace",
                            memoryLayerKey: "/repo/taco",
                            readOnly: true,
                        },
                    ],
                }}
                loading={false}
                error={null}
                selectedId={MEMORY_ROOT_ID}
                onSelect={() => {}}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => true}
                onRefresh={() => {}}
                saving={false}
            />,
        );

        expect(screen.getByRole("tab", { name: "memory.layer.currentChannel" })).toBeTruthy();
        expect(screen.getByRole("tab", { name: "memory.layer.associated" })).toBeTruthy();
        fireEvent.click(screen.getByRole("tab", { name: "memory.layer.associated" }));
        expect(screen.getByText("Workspace role")).toBeTruthy();
        expect(screen.queryByText("memory.delete")).toBeNull();

        fireEvent.click(screen.getByRole("tab", { name: "memory.layer.managedGlobal" }));
        expect(screen.getByText("memory.managedDisabled")).toBeTruthy();
    });

    it.each([undefined, "current"] as const)(
        "uses the writable topic name in dream previews when its layer is %s and inherited ids collide",
        (memoryLayer) => {
            render(
                <MemoryPane
                    data={{
                        ...sampleData,
                        topics: [
                            { ...sampleData.topics[0], memoryLayer },
                            {
                                ...sampleData.topics[0],
                                name: "Inherited workspace topic",
                                memoryLayer: "workspace",
                                memoryLayerKey: "/repo/taco",
                                readOnly: true,
                            },
                            {
                                ...sampleData.topics[0],
                                name: "Inherited global topic",
                                memoryLayer: "managed-global",
                                readOnly: true,
                            },
                        ],
                        dream: {
                            confirmed: false,
                            reports: [],
                            archived: [],
                            pending: {
                                id: "preview-1",
                                createdAt: "2026-11-01T00:00:00.000Z",
                                actions: [
                                    {
                                        action: "rewrite",
                                        id: "user_role",
                                        content: "User prefers pnpm.",
                                    },
                                ],
                                snapshot: { user_role: "topic-hash" },
                                topicCount: 1,
                                counts: { merged: 0, mergedInto: 0, rewritten: 1, archived: 0 },
                            },
                        },
                    }}
                    loading={false}
                    error={null}
                    selectedId={MEMORY_ROOT_ID}
                    onSelect={() => {}}
                    onSaveMemory={async () => ({ ok: true })}
                    onDeleteTopic={async () => true}
                    onRefresh={() => {}}
                    saving={false}
                    dream={{
                        busy: null,
                        onRun: vi.fn(),
                        onApply: vi.fn(),
                        onDiscard: vi.fn(),
                        onUndo: vi.fn(),
                        onRestoreTopic: async () => true,
                        onScheduleToggle: vi.fn(),
                        dreamConfig: null,
                        onSaveConfig: async () => true,
                    }}
                />,
            );

            const preview = screen.getByRole("region", { name: "memory.dream.pendingTitle" });
            expect(preview.querySelector("summary")?.textContent).toBe("User uses pnpm");
            expect(within(preview).queryByText("Inherited workspace topic")).toBeNull();
            expect(within(preview).queryByText("Inherited global topic")).toBeNull();
        },
    );

    it("keeps associated memory read-only while current memory remains editable", () => {
        const onSelect = vi.fn();
        const data = {
            ...sampleData,
            memorySources: {
                target: "channel" as const,
                associatedWorkspaces: ["/repo/taco"],
                managedGlobal: { enabled: true },
            },
            topics: [
                {
                    ...sampleData.topics[0],
                    memoryLayer: "current" as const,
                    memoryLayerKey: "im://wechat/peer/chat",
                    readOnly: false,
                },
                {
                    id: "workspace_role",
                    name: "Workspace role",
                    description: "Workspace memory",
                    type: "project" as const,
                    content: "Inherited from the associated workspace.",
                    createdAt: "2026-07-29T00:00:00.000Z",
                    memoryLayer: "workspace" as const,
                    memoryLayerKey: "/repo/taco",
                    readOnly: true,
                },
            ],
        };
        const { rerender } = render(
            <MemoryPane
                data={data}
                loading={false}
                error={null}
                selectedId={MEMORY_ROOT_ID}
                onSelect={onSelect}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => true}
                onRefresh={() => {}}
                saving={false}
            />,
        );

        fireEvent.click(screen.getByRole("tab", { name: "memory.layer.associated" }));
        fireEvent.click(screen.getByRole("button", { name: /Workspace role/ }));
        expect(onSelect).toHaveBeenCalledWith("workspace:/repo/taco:workspace_role");

        rerender(
            <MemoryPane
                data={data}
                loading={false}
                error={null}
                selectedId="workspace:/repo/taco:workspace_role"
                onSelect={onSelect}
                onSaveMemory={async () => ({ ok: true })}
                onDeleteTopic={async () => true}
                onRefresh={() => {}}
                saving={false}
            />,
        );
        fireEvent.click(screen.getByRole("tab", { name: "memory.layer.associated" }));
        fireEvent.click(screen.getByRole("button", { name: /Workspace role/ }));
        expect(screen.getByText("memory.inheritedReadOnly")).toBeTruthy();
        expect(screen.queryByText("memory.delete")).toBeNull();
    });
});
