/**
 * MemoryPane — view component tests.
 * No sidecar/RPC dependencies; all callbacks are vi.fn() fakes.
 */

import { strict as assert } from "node:assert";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryPane } from "../../src/views/MemoryPane";
import { MEMORY_ROOT_ID } from "../../src/views/memoryPaneTypes";

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
});
