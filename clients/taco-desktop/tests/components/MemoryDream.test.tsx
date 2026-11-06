import type { MemoryListResult, MemoryTopicEntry } from "@taco-ai/protocol";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

const topic = (id: string, name = id, extras: Record<string, unknown> = {}): MemoryTopicEntry => ({
    id,
    name,
    description: `${name} description`,
    type: "project",
    content: `content of ${id}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...extras,
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
        onRestoreTopic: vi.fn(async () => true),
        onScheduleToggle: vi.fn(),
        dreamConfig: {
            minHours: 24,
            minChanges: 5,
            staleDays: 90,
            staleDaysDurable: 180,
            archiveCleanupEnabled: false,
            archiveRetentionDays: 7,
        },
        onSaveConfig: vi.fn(),
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
        const user = userEvent.setup({ delay: null });
        const { dream } = renderPane();

        await user.click(screen.getByRole("button", { name: "memory.dream.run" }));
        expect(dream.onRun).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("switch", { name: "memory.dream.schedule" }));
        expect(dream.onScheduleToggle).toHaveBeenCalledWith(false);
    });

    it("opens schedule settings from the consolidation panel", async () => {
        const user = userEvent.setup({ delay: null });
        const dream = actions();
        renderPane(dream);

        await user.click(screen.getByRole("button", { name: "memory.dream.settings" }));
        expect(screen.getByText("memory.dream.minHours")).toBeTruthy();
        expect(dream.onSaveConfig).not.toHaveBeenCalled();
    });

    it("saves memory settings from the expanded settings card", async () => {
        const user = userEvent.setup({ delay: null });
        const dream = actions();
        renderPane(dream);
        await user.click(screen.getByRole("button", { name: "memory.dream.settings" }));
        const minHours = screen.getByLabelText("memory.dream.minHours") as HTMLInputElement;
        await user.clear(minHours);
        await user.type(minHours, "48");
        await user.click(screen.getByRole("button", { name: "memory.dream.saveSettings" }));
        expect(dream.onSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ minHours: 48 }));
    });

    it("applies the reviewed preview and can discard it", async () => {
        const user = userEvent.setup({ delay: null });
        const { dream } = renderPane();

        expect(screen.getByText("memory.dream.pendingTitle")).toBeTruthy();
        expect(screen.getByText(/a \+ b → AB/)).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "memory.dream.apply" }));
        expect(dream.onApply).toHaveBeenCalledWith("preview-1");
        await user.click(screen.getByRole("button", { name: "memory.dream.discard" }));
        expect(dream.onDiscard).toHaveBeenCalledTimes(1);
    });

    it("opens run history and undoes the selected report", async () => {
        const user = userEvent.setup({ delay: null });
        const { dream } = renderPane();
        const history = document.querySelector(".memory-dream-history");
        expect(history).toBeTruthy();
        fireEvent.click(history?.querySelector("summary") as Element);

        await user.click(screen.getByRole("button", { name: "memory.dream.undo" }));
        expect(dream.onUndo).toHaveBeenCalledWith("report-1");
    });

    it("shows undo expiry and hides undo after the expiry time", () => {
        const expired = {
            id: "expired-report",
            appliedAt: "2026-10-24T00:00:00.000Z",
            undoExpiredAt: "2026-11-05T00:00:00.000Z",
            counts: { merged: 1, mergedInto: 1, rewritten: 0, archived: 0 },
            skipped: 0,
        };
        renderPane(actions(), MEMORY_ROOT_ID, {
            ...dreamData,
            dream: {
                confirmed: false,
                pending: dreamData.dream?.pending,
                lastRunAt: dreamData.dream?.lastRunAt,
                archived: dreamData.dream?.archived ?? [],
                reports: [expired],
            },
        });
        const history = document.querySelector(".memory-dream-history");
        fireEvent.click(history?.querySelector("summary") as Element);
        expect(screen.getByText(/memory\.dream\.undoExpired/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "memory.dream.undo" })).toBeNull();
        expect(screen.queryByText("memory.dream.undoExpires")).toBeNull();
    });

    it("selects an archived topic separately from live topics and restores it", async () => {
        const user = userEvent.setup({ delay: null });
        const { onSelect, dream } = renderPane(actions(), `${MEMORY_ARCHIVE_PREFIX}old`);

        expect(screen.getAllByText("Old archived fact").length).toBeGreaterThan(0);
        await user.click(screen.getByRole("button", { name: "memory.dream.restore" }));
        expect(dream.onRestoreTopic).toHaveBeenCalledWith("old");
        // Lands on the restored topic rather than the top of the list.
        expect(onSelect).toHaveBeenCalledWith("old");
    });

    it("stays on the archived topic when the restore fails", async () => {
        const user = userEvent.setup({ delay: null });
        const failing = { ...actions(), onRestoreTopic: vi.fn(async () => false) };
        const { onSelect } = renderPane(failing, `${MEMORY_ARCHIVE_PREFIX}old`);
        await user.click(screen.getByRole("button", { name: "memory.dream.restore" }));
        expect(failing.onRestoreTopic).toHaveBeenCalledWith("old");
        expect(onSelect).not.toHaveBeenCalled();
    });

    it("opens consolidation from the header when nothing is pending", async () => {
        const user = userEvent.setup({ delay: null });
        const current = dreamData.dream;
        if (!current) throw new Error("fixture is missing dream state");
        const noPending: MemoryListResult = {
            ...dreamData,
            dream: {
                confirmed: current.confirmed,
                reports: current.reports,
                archived: current.archived,
            },
        };
        renderPane(actions(), MEMORY_ROOT_ID, noPending);

        expect(screen.queryByRole("button", { name: "memory.dream.run" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "memory.dream.open" }));
        expect(screen.getByRole("button", { name: "memory.dream.run" })).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "memory.dream.close" }));
        expect(screen.queryByRole("button", { name: "memory.dream.run" })).toBeNull();
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

describe("memory Markdown and provenance", () => {
    it("shows proposed titles and summaries before applying a dream preview", () => {
        const current = dreamData.dream;
        if (!current) throw new Error("missing dream fixture");
        renderPane(actions(), MEMORY_ROOT_ID, {
            ...dreamData,
            dream: {
                ...current,
                pending: {
                    ...preview,
                    actions: [
                        {
                            action: "rewrite",
                            id: "c",
                            name: "Proposed title",
                            description: "Proposed relevance",
                            content: "body",
                        },
                        {
                            ...preview.actions[0],
                            action: "merge",
                            sourceIds: ["a", "b"],
                            id: "ab",
                            name: "Merged title",
                            description: "Merged relevance",
                            type: "project",
                            content: "merged body",
                        },
                    ],
                },
            },
        });
        expect(screen.getByText("Proposed title")).toBeTruthy();
        expect(screen.getByText("Proposed relevance")).toBeTruthy();
        expect(screen.getByText("Merged relevance")).toBeTruthy();
    });
    afterEach(cleanup);
    const source = {
        sessionId: "original-session-123",
        recordedAt: "2026-11-01T08:00:00.000Z",
        via: "auto" as const,
        entryId: "original-entry-456",
    };
    const fact = {
        ...topic("fact"),
        content: "## Fact heading\n\nUse **pnpm** and `taco`.\n\n- first\n- second",
        sources: [source],
    };
    for (const archived of [false, true]) {
        it(`renders ${archived ? "archived" : "active"} memory as Markdown and shows source metadata`, () => {
            const data: MemoryListResult = {
                ...dreamData,
                topics: archived ? [] : [fact],
                dream: { confirmed: false, reports: [], archived: archived ? [fact] : [] },
            };
            renderPane(actions(), archived ? `${MEMORY_ARCHIVE_PREFIX}fact` : "fact", data);
            const detail = document.querySelector(".memory-detail") as HTMLElement;
            expect(within(detail).getByRole("heading", { name: "Fact heading" })).toBeTruthy();
            expect(detail.querySelector("strong")?.textContent).toBe("pnpm");
            expect(detail.querySelector("code")?.textContent).toBe("taco");
            expect(detail.querySelectorAll("li")).toHaveLength(3);
            expect(within(detail).getByText(source.sessionId)).toBeTruthy();
            expect(within(detail).getByText(source.entryId)).toBeTruthy();
            expect(detail.querySelector(`time[datetime="${source.recordedAt}"]`)).toBeTruthy();
            expect(within(detail).getByText("auto")).toBeTruthy();
        });
    }

    it("shows an archive timestamp alongside an archived memory", () => {
        const archived = topic("dated", "Dated archive", {
            archivedAt: "2026-11-01T00:00:00.000Z",
        });
        renderPane(actions(), `${MEMORY_ARCHIVE_PREFIX}dated`, {
            ...dreamData,
            topics: [],
            dream: { confirmed: false, reports: [], archived: [archived] },
        });
        expect(screen.getByText("memory.dream.archivedAt")).toBeTruthy();
        expect(document.querySelector('time[datetime="2026-11-01T00:00:00.000Z"]')).toBeTruthy();
    });
    it("renders old memories without an empty provenance section", () => {
        renderPane(actions(), "live");
        expect(document.querySelector(".memory-view-sources")).toBeNull();
    });
    it("renders merge and rewrite preview bodies as Markdown", () => {
        const current = dreamData.dream;
        const merge = preview.actions[0];
        if (!current || merge?.action !== "merge") throw new Error("fixture missing preview");
        const data: MemoryListResult = {
            ...dreamData,
            dream: {
                ...current,
                pending: {
                    ...preview,
                    actions: [
                        { ...merge, content: "**Merged fact**" },
                        { action: "rewrite", id: "c", content: "## Rewritten fact" },
                    ],
                },
            },
        };
        renderPane(actions(), MEMORY_ROOT_ID, data);
        const bodies = document.querySelectorAll(".memory-dream-action-body");
        expect(bodies[0]?.querySelector("strong")?.textContent).toBe("AB");
        expect(bodies[0]?.querySelector(".md-assistant strong")?.textContent).toBe("Merged fact");
        expect(bodies[1]?.querySelector("h2")?.textContent).toBe("Rewritten fact");
    });
});
