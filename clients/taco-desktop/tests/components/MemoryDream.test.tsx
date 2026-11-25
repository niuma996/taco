import type { MemoryListResult, MemoryTopicEntry } from "@taco-ai/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryDreamPanel } from "../../src/components/memory/MemoryDreamPanel";
import en from "../../src/i18n/locales/en.json";
import zh from "../../src/i18n/locales/zh.json";
import { MEMORY_ARCHIVE_PREFIX, MEMORY_ROOT_ID } from "../../src/lib/memoryPaneTypes";
import { MemoryPane } from "../../src/views/MemoryPane";

// The locale suite needs the real translations, so the mock hands the hook back
// untouched while the flag is on.
const useRealTranslations = vi.hoisted(() => ({ on: false }));

vi.mock("react-i18next", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-i18next")>();
    return {
        ...actual,
        useTranslation: (...args: unknown[]) =>
            useRealTranslations.on
                ? (actual.useTranslation as (...a: unknown[]) => unknown)(...args)
                : { t: (key: string) => key, i18n: { language: "en" } },
    };
});

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
            staleDays: 90,
            staleDaysDurable: 180,
            archiveCleanupEnabled: false,
            archiveRetentionDays: 7 as const,
        },
        onSaveConfig: vi.fn(async () => true),
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

    it.each(["run", "apply", "undo"] as const)(
        "prevents repeated run and undo actions while busy with %s",
        async (busy) => {
            const user = userEvent.setup({ delay: null });
            const dream = { ...actions(), dreamConfig: null };
            const { rerender } = render(
                <MemoryDreamPanel
                    {...dream}
                    state={dreamData.dream}
                    busy={busy}
                    onClose={() => {}}
                />,
            );
            const runLabel = busy === "run" ? "memory.dream.running" : "memory.dream.run";
            const run = screen.getByRole("button", { name: runLabel });
            expect(run.getAttribute("title")).toBe(runLabel);
            expect(run.getAttribute("aria-busy")).toBe(String(busy === "run"));
            expect(run).toHaveProperty("disabled", true);
            await user.click(run);
            fireEvent.click(document.querySelector(".memory-dream-history summary") as Element);
            const undo = screen.getByRole("button", {
                name: busy === "undo" ? "memory.dream.undoing" : "memory.dream.undo",
            });
            expect(undo).toHaveProperty("disabled", true);
            await user.click(undo);
            expect(dream.onRun).not.toHaveBeenCalled();
            expect(dream.onUndo).not.toHaveBeenCalled();

            rerender(<MemoryDreamPanel {...dream} state={dreamData.dream} onClose={() => {}} />);
            await user.click(screen.getByRole("button", { name: "memory.dream.run" }));
            await user.click(screen.getByRole("button", { name: "memory.dream.undo" }));
            expect(dream.onRun).toHaveBeenCalledTimes(1);
            expect(dream.onUndo).toHaveBeenCalledWith("report-1");
        },
    );

    it("saves memory settings from the expanded settings card", async () => {
        const user = userEvent.setup({ delay: null });
        const dream = actions();
        renderPane(dream);
        await user.click(screen.getByRole("button", { name: "memory.dream.settings" }));
        for (const [name, value, min, max] of [
            ["memory.dream.minHours", "48", "1", "720"],
            ["memory.dream.staleDays", "120", "7", "3650"],
            ["memory.dream.staleDaysDurable", "365", "7", "3650"],
        ]) {
            const input = screen.getByRole("spinbutton", { name });
            expect(screen.getByLabelText(name)).toBe(input);
            expect(input).toHaveProperty("min", min);
            expect(input).toHaveProperty("max", max);
            await user.clear(input);
            await user.type(input, value);
        }
        await user.click(screen.getByRole("button", { name: "memory.dream.saveSettings" }));
        expect(dream.onSaveConfig).toHaveBeenCalledWith({
            ...dream.dreamConfig,
            minHours: 48,
            staleDays: 120,
            staleDaysDurable: 365,
        });
        expect(screen.queryByRole("button", { name: "memory.dream.saveSettings" })).toBeNull();
        expect(
            screen
                .getByRole("button", { name: "memory.dream.settings" })
                .getAttribute("aria-expanded"),
        ).toBe("false");
    });

    it("retains the selected retention when cleanup is toggled and saves both settings", async () => {
        const user = userEvent.setup({ delay: null });
        const dream = actions();
        renderPane(dream);
        expect(screen.queryByRole("spinbutton")).toBeNull();
        await user.click(screen.getByRole("button", { name: "memory.dream.settings" }));
        const cleanupSwitch = screen.getByRole("switch", { name: "memory.dream.archiveCleanup" });
        const retention = screen.getByRole("combobox", { name: "memory.dream.archiveRetention" });
        expect(screen.getByLabelText("memory.dream.archiveRetention")).toBe(retention);
        expect(cleanupSwitch.getAttribute("aria-checked")).toBe("false");
        expect(retention).toHaveProperty("disabled", true);

        await user.click(screen.getByText("memory.dream.archiveCleanup"));
        expect(cleanupSwitch.getAttribute("aria-checked")).toBe("true");
        expect(retention).toHaveProperty("disabled", false);
        await user.click(retention);
        await user.click(
            await screen.findByRole("option", { name: "memory.dream.archiveRetention30" }),
        );
        await user.click(cleanupSwitch);
        expect(retention).toHaveProperty("disabled", true);
        expect(retention.textContent).toContain("memory.dream.archiveRetention30");
        await user.click(screen.getByRole("button", { name: "memory.dream.saveSettings" }));
        expect(dream.onSaveConfig).toHaveBeenLastCalledWith({
            ...dream.dreamConfig,
            archiveCleanupEnabled: false,
            archiveRetentionDays: 30,
        });

        await user.click(screen.getByRole("button", { name: "memory.dream.settings" }));
        expect(retention.textContent).toContain("memory.dream.archiveRetention30");
        await user.click(cleanupSwitch);
        expect(retention).toHaveProperty("disabled", false);
        await user.click(screen.getByRole("button", { name: "memory.dream.saveSettings" }));
        expect(dream.onSaveConfig).toHaveBeenLastCalledWith({
            ...dream.dreamConfig,
            archiveCleanupEnabled: true,
            archiveRetentionDays: 30,
        });
    });

    it.each([false, true])(
        "disables settings while saving and retains the failed draft with cleanup %s",
        async (archiveCleanupEnabled) => {
            const user = userEvent.setup({ delay: null });
            const dream = actions();
            dream.dreamConfig.archiveCleanupEnabled = archiveCleanupEnabled;
            let finish!: (saved: boolean) => void;
            dream.onSaveConfig.mockImplementationOnce(
                () =>
                    new Promise<boolean>((resolve) => {
                        finish = resolve;
                    }),
            );
            renderPane(dream);
            await user.click(screen.getByRole("button", { name: "memory.dream.settings" }));
            const minHours = screen.getByLabelText("memory.dream.minHours") as HTMLInputElement;
            await user.clear(minHours);
            await user.type(minHours, "48");
            await user.click(screen.getByRole("button", { name: "memory.dream.saveSettings" }));
            const saving = screen.getByRole("button", { name: "app.saving" });
            expect(saving).toHaveProperty("disabled", true);
            const cleanupSwitch = screen.getByLabelText("memory.dream.archiveCleanup");
            const retention = screen.getByRole("combobox", {
                name: "memory.dream.archiveRetention",
            });
            for (const control of [
                ...screen.getAllByRole("spinbutton"),
                cleanupSwitch,
                retention,
            ]) {
                expect(control).toHaveProperty("disabled", true);
            }
            await user.type(minHours, "72");
            await user.click(cleanupSwitch);
            await user.click(retention);
            expect(screen.queryByRole("option")).toBeNull();
            expect(minHours.value).toBe("48");
            expect(cleanupSwitch.getAttribute("aria-checked")).toBe(String(archiveCleanupEnabled));
            await user.click(saving);
            expect(dream.onSaveConfig).toHaveBeenCalledTimes(1);
            await act(async () => finish(false));
            expect(
                screen.getByRole("button", { name: "memory.dream.saveSettings" }),
            ).toHaveProperty("disabled", false);
            expect(screen.getByRole("alert").textContent).toBe("memory.dream.error.settings");
            for (const control of [...screen.getAllByRole("spinbutton"), cleanupSwitch]) {
                expect(control).toHaveProperty("disabled", false);
            }
            expect(retention).toHaveProperty("disabled", !archiveCleanupEnabled);
            expect(screen.getByLabelText("memory.dream.minHours")).toHaveProperty("value", "48");
            await user.click(screen.getByRole("button", { name: "memory.dream.saveSettings" }));
            expect(dream.onSaveConfig).toHaveBeenLastCalledWith({
                ...dream.dreamConfig,
                minHours: 48,
            });
            expect(screen.queryByRole("button", { name: "memory.dream.saveSettings" })).toBeNull();
        },
    );

    it("shows a rejected save and keeps settings open for retry", async () => {
        const user = userEvent.setup({ delay: null });
        const dream = actions();
        dream.onSaveConfig.mockRejectedValueOnce(new Error("connection lost"));
        renderPane(dream);
        await user.click(screen.getByRole("button", { name: "memory.dream.settings" }));
        await user.click(screen.getByRole("button", { name: "memory.dream.saveSettings" }));
        expect(screen.getByRole("alert").textContent).toBe("memory.dream.error.settings");
        expect(screen.getByRole("button", { name: "memory.dream.saveSettings" })).toHaveProperty(
            "disabled",
            false,
        );
    });

    it.each([
        ["memory.dream.minHours", "", "1", "720"],
        ["memory.dream.minHours", "0", "1", "720"],
        ["memory.dream.minHours", "1.5", "1", "720"],
        ["memory.dream.minHours", "721", "1", "720"],
        ["memory.dream.staleDays", "6", "7", "3650"],
        ["memory.dream.staleDaysDurable", "3651", "7", "3650"],
    ])("blocks invalid %s=%s without sending a config", async (name, value) => {
        const dream = actions();
        renderPane(dream);
        await userEvent.click(screen.getByRole("button", { name: "memory.dream.settings" }));
        const input = screen.getByRole("spinbutton", { name });
        fireEvent.change(input, { target: { value } });
        const save = screen.getByRole("button", { name: "memory.dream.saveSettings" });
        await waitFor(() => expect(save).toHaveProperty("disabled", true));
        expect(input.getAttribute("aria-invalid")).toBe("true");
        await userEvent.click(save);
        expect(dream.onSaveConfig).not.toHaveBeenCalled();
    });

    it.each([
        [1, 7, 7],
        [720, 3650, 3650],
    ])(
        "saves inclusive integer boundaries %s/%s/%s",
        async (minHours, staleDays, staleDaysDurable) => {
            const dream = actions();
            renderPane(dream);
            await userEvent.click(screen.getByRole("button", { name: "memory.dream.settings" }));
            for (const [name, value] of Object.entries({ minHours, staleDays, staleDaysDurable })) {
                fireEvent.change(screen.getByLabelText(`memory.dream.${name}`), {
                    target: { value: String(value) },
                });
            }
            const save = screen.getByRole("button", { name: "memory.dream.saveSettings" });
            await waitFor(() => expect(save).toHaveProperty("disabled", false));
            await userEvent.click(save);
            await waitFor(() =>
                expect(dream.onSaveConfig).toHaveBeenCalledWith({
                    ...dream.dreamConfig,
                    minHours,
                    staleDays,
                    staleDaysDurable,
                }),
            );
        },
    );

    it("prevents same-batch duplicate settings saves and permits retry", async () => {
        const dream = actions();
        let finish = (_saved: boolean) => {};
        dream.onSaveConfig.mockImplementationOnce(
            () =>
                new Promise<boolean>((resolve) => {
                    finish = resolve;
                }),
        );
        renderPane(dream);
        await userEvent.click(screen.getByRole("button", { name: "memory.dream.settings" }));
        const save = screen.getByRole("button", { name: "memory.dream.saveSettings" });
        await waitFor(() => expect(save).toHaveProperty("disabled", false));
        await act(async () => {
            fireEvent.click(save);
            fireEvent.click(save);
        });
        const calls = dream.onSaveConfig.mock.calls.length;
        await act(async () => finish(false));
        expect(calls).toBe(1);
        await userEvent.click(screen.getByRole("button", { name: "memory.dream.saveSettings" }));
        await waitFor(() => expect(dream.onSaveConfig).toHaveBeenCalledTimes(2));
    });

    it("keeps settings locked when refreshed config arrives during a pending save", async () => {
        const dream = actions();
        let finish = (_saved: boolean) => {};
        dream.onSaveConfig.mockImplementationOnce(
            () =>
                new Promise<boolean>((resolve) => {
                    finish = resolve;
                }),
        );
        const { rerender } = render(<MemoryDreamPanel {...dream} onClose={() => {}} />);
        await userEvent.click(screen.getByRole("button", { name: "memory.dream.settings" }));
        await userEvent.click(screen.getByRole("button", { name: "memory.dream.saveSettings" }));
        await screen.findByRole("button", { name: "app.saving" });
        rerender(
            <MemoryDreamPanel
                {...dream}
                dreamConfig={{ ...dream.dreamConfig, minHours: 72 }}
                onClose={() => {}}
            />,
        );
        const locked = (screen.getByLabelText("memory.dream.minHours") as HTMLInputElement)
            .disabled;
        await act(async () => finish(false));
        expect(locked).toBe(true);
        await waitFor(() =>
            expect(screen.getByLabelText("memory.dream.minHours")).toHaveProperty("value", "72"),
        );
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "memory.dream.saveSettings" }),
            ).toHaveProperty("disabled", false),
        );
    });

    it("preserves the draft while collapsed and resets when the config changes", async () => {
        const dream = actions();
        const { rerender } = render(<MemoryDreamPanel {...dream} onClose={() => {}} />);
        const toggle = screen.getByRole("button", { name: "memory.dream.settings" });
        await userEvent.click(toggle);
        fireEvent.change(screen.getByLabelText("memory.dream.minHours"), {
            target: { value: "48" },
        });
        await userEvent.click(toggle);
        await userEvent.click(toggle);
        expect(screen.getByLabelText("memory.dream.minHours")).toHaveProperty("value", "48");
        rerender(
            <MemoryDreamPanel
                {...dream}
                dreamConfig={{ ...dream.dreamConfig, minHours: 72 }}
                onClose={() => {}}
            />,
        );
        await waitFor(() =>
            expect(screen.getByLabelText("memory.dream.minHours")).toHaveProperty("value", "72"),
        );
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

describe("MemoryDreamPanel locale", () => {
    beforeAll(() => {
        useRealTranslations.on = true;
    });
    afterAll(() => {
        useRealTranslations.on = false;
    });
    afterEach(cleanup);

    it("translates consolidation settings and updates them when the UI language changes", async () => {
        const i18n = createInstance();
        await i18n.use(initReactI18next).init({
            lng: "zh",
            fallbackLng: "en",
            resources: { zh: { translation: zh }, en: { translation: en } },
            interpolation: { escapeValue: false },
        });
        render(
            <I18nextProvider i18n={i18n}>
                <MemoryDreamPanel
                    busy={null}
                    scheduled
                    onRun={vi.fn()}
                    onApply={vi.fn()}
                    onDiscard={vi.fn()}
                    onUndo={vi.fn()}
                    onScheduleToggle={vi.fn()}
                    onSaveConfig={vi.fn(async () => true)}
                    onClose={vi.fn()}
                    dreamConfig={{
                        minHours: 24,
                        staleDays: 90,
                        staleDaysDurable: 180,
                        archiveCleanupEnabled: true,
                        archiveRetentionDays: 7,
                    }}
                />
            </I18nextProvider>,
        );
        fireEvent.click(screen.getByRole("button", { name: "记忆整理设置" }));
        expect(screen.getByLabelText("最短整理间隔（小时）")).toBeTruthy();
        expect(screen.getByLabelText("项目与参考记忆闲置天数")).toBeTruthy();
        expect(screen.getByLabelText("用户偏好与反馈记忆闲置天数")).toBeTruthy();
        expect(screen.getByLabelText("删除过期的已归档记忆")).toBeTruthy();
        expect(screen.getByLabelText("归档保留时间")).toBeTruthy();
        expect(screen.getByLabelText("归档保留时间").textContent).toContain("7 天");
        expect(i18n.t("memory.dream.archiveRetention30")).toBe("30 天");
        expect(i18n.t("memory.dream.archiveRetention90")).toBe("90 天");
        expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();

        await act(() => i18n.changeLanguage("en"));
        expect(screen.getByRole("button", { name: "Memory consolidation settings" })).toBeTruthy();
        expect(screen.getByLabelText("Minimum hours between evaluations")).toBeTruthy();
        expect(screen.getByLabelText("Project/reference idle days")).toBeTruthy();
        expect(screen.getByLabelText("User/feedback idle days")).toBeTruthy();
        expect(screen.getByLabelText("Delete expired archived memories")).toBeTruthy();
        expect(screen.getByLabelText("Archive retention")).toBeTruthy();
        expect(screen.getByLabelText("Archive retention").textContent).toContain("7 days");
        expect(i18n.t("memory.dream.archiveRetention30")).toBe("30 days");
        expect(i18n.t("memory.dream.archiveRetention90")).toBe("90 days");
        expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    });
});
