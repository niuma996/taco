import type { MemoryListResult, MemoryTopicEntry } from "@taco-ai/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_ARCHIVE_PREFIX, MEMORY_ROOT_ID } from "../../src/lib/memoryPaneTypes";
import { MemoryPane } from "../../src/views/MemoryPane";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({
        t: (key: string) => key,
        i18n: { language: "en" },
    })),
}));

const topic = (id: string, name = id): MemoryTopicEntry => ({
    id,
    name,
    description: `${name} description`,
    type: "project",
    content: `content of ${id}`,
    createdAt: "2026-10-01T00:00:00.000Z",
});

const preview = {
    id: "preview-1",
    createdAt: "2026-10-25T00:00:00.000Z",
    actions: [
        {
            action: "merge" as const,
            sourceIds: ["a", "b"],
            id: "ab",
            name: "AB",
            description: "merged",
            type: "project" as const,
            content: "a and b",
        },
        { action: "rewrite" as const, id: "c", content: "tightened c" },
        { action: "archive" as const, id: "old", reason: "superseded", supersededBy: "ab" },
    ],
    snapshot: { a: "a", b: "b", c: "c", old: "old" },
    topicCount: 10,
    counts: { merged: 2, mergedInto: 1, rewritten: 1, archived: 1 },
};

const dreamData: MemoryListResult = {
    enabled: true,
    memoryContent: "# Memory\n\n## Notes\n\nhello",
    memoryHash: "hash",
    topics: [topic("live")],
    dreamScheduled: true,
    dream: {
        pending: preview,
        confirmed: false,
        lastRunAt: "2026-10-25T00:00:00.000Z",
        reports: [
            {
                id: "report-1",
                appliedAt: "2026-10-24T00:00:00.000Z",
                counts: { merged: 4, mergedInto: 2, rewritten: 0, archived: 1 },
                skipped: 0,
            },
        ],
        archived: [topic("old", "Old archived fact")],
    },
};

function actions() {
    return {
        busy: null,
        onRun: vi.fn(),
        onApply: vi.fn(),
        onDiscard: vi.fn(),
        onUndo: vi.fn(),
        onRestoreTopic: vi.fn(),
        onScheduleToggle: vi.fn(),
    };
}

function renderPane(
    dream = actions(),
    selectedId = MEMORY_ROOT_ID,
    data: MemoryListResult = dreamData,
) {
    const onSelect = vi.fn();
    render(
        <MemoryPane
            data={data}
            loading={false}
            error={null}
            selectedId={selectedId}
            onSelect={onSelect}
            onSaveMemory={async () => ({ ok: true })}
            onDeleteTopic={async () => {}}
            onRefresh={() => {}}
            saving={false}
            dream={dream}
        />,
    );
    return { onSelect, dream };
}

describe("MemoryPane dream controls", () => {
    afterEach(cleanup);

    it("runs a manual consolidation and toggles the shared schedule", async () => {
        const user = userEvent.setup();
        const { dream } = renderPane();

        await user.click(screen.getByRole("button", { name: "memory.dream.run" }));
        expect(dream.onRun).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("switch", { name: "memory.dream.schedule" }));
        expect(dream.onScheduleToggle).toHaveBeenCalledWith(false);
    });

    it("applies the reviewed preview and can discard it", async () => {
        const user = userEvent.setup();
        const { dream } = renderPane();

        expect(screen.getByText("memory.dream.pendingTitle")).toBeTruthy();
        expect(screen.getByText(/a, b/)).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "memory.dream.apply" }));
        expect(dream.onApply).toHaveBeenCalledWith("preview-1");
        await user.click(screen.getByRole("button", { name: "memory.dream.discard" }));
        expect(dream.onDiscard).toHaveBeenCalledTimes(1);
    });

    it("opens run history and undoes the selected report", async () => {
        const user = userEvent.setup();
        const { dream } = renderPane();
        const history = document.querySelector(".memory-dream-history");
        expect(history).toBeTruthy();
        fireEvent.click(history?.querySelector("summary") as Element);

        await user.click(screen.getByRole("button", { name: "memory.dream.undo" }));
        expect(dream.onUndo).toHaveBeenCalledWith("report-1");
    });

    it("selects an archived topic separately from live topics and restores it", async () => {
        const user = userEvent.setup();
        const { onSelect, dream } = renderPane(actions(), `${MEMORY_ARCHIVE_PREFIX}old`);

        expect(screen.getAllByText("Old archived fact").length).toBeGreaterThan(0);
        await user.click(screen.getByRole("button", { name: "memory.dream.restore" }));
        expect(dream.onRestoreTopic).toHaveBeenCalledWith("old");
        expect(onSelect).toHaveBeenCalledWith(MEMORY_ROOT_ID);
    });

    it("disables the schedule switch when the daemon has no scheduler", () => {
        const data = { ...dreamData, dreamScheduled: undefined };
        renderPane(actions(), MEMORY_ROOT_ID, data);
        expect(screen.getByRole("switch", { name: "memory.dream.schedule" })).toHaveProperty(
            "disabled",
            true,
        );
        expect(screen.getByText("memory.dream.scheduleUnavailable")).toBeTruthy();
    });
});
