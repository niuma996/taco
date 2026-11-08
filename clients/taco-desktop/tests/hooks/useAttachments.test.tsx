import type { AttachmentStageResult } from "@taco-ai/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ClipboardEvent, Dispatch, SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAttachments } from "../../src/hooks/primitives/useAttachments";
import {
    ATTACHMENT_MAX_COUNT,
    type StagedAttachment,
    type StageFn,
} from "../../src/lib/attachments";

const native = vi.hoisted(() => ({
    open: vi.fn<() => Promise<string[] | null>>(),
    listen: vi.fn(),
    unlisten: vi.fn(),
    showToast: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: native.open }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset://${path}` }));
vi.mock("@tauri-apps/api/webview", () => ({
    getCurrentWebview: () => ({ onDragDropEvent: native.listen }),
}));
vi.mock("../../src/hooks/primitives/useToast", () => ({
    useToast: () => ({ show: native.showToast }),
}));
vi.mock("../../src/i18n/useI18n", () => ({ useT: () => ({ t: (key: string) => key }) }));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}

function attachment(id: string, kind: "image" | "file" = "file"): StagedAttachment {
    return { id, name: id, kind, mimeType: kind === "image" ? "image/png" : "text/plain", size: 1 };
}

function paste(file: File): ClipboardEvent<HTMLTextAreaElement> {
    return {
        clipboardData: { items: [{ kind: "file", getAsFile: () => file }] },
        preventDefault: vi.fn(),
    } as unknown as ClipboardEvent<HTMLTextAreaElement>;
}

function setup(initial: StagedAttachment[] = []) {
    const drafts: Record<string, StagedAttachment[]> = {
        a: initial,
        b: [attachment("b-existing")],
    };
    const stageA = vi.fn<StageFn>().mockResolvedValue(attachment("a-picked"));
    const stageB = vi.fn<StageFn>().mockResolvedValue(attachment("b-picked"));
    const updates = { a: vi.fn(), b: vi.fn() };
    const hook = renderHook(
        ({ target, enabled }: { target: "a" | "b"; enabled: boolean }) => {
            const setter: Dispatch<SetStateAction<StagedAttachment[]>> = (next) => {
                updates[target](next);
                drafts[target] = typeof next === "function" ? next(drafts[target] ?? []) : next;
            };
            return useAttachments(
                drafts[target] ?? [],
                setter,
                target === "a" ? stageA : stageB,
                enabled,
            );
        },
        { initialProps: { target: "a" as "a" | "b", enabled: true } },
    );
    return { ...hook, drafts, stageA, stageB, updates };
}

beforeEach(() => {
    vi.clearAllMocks();
    native.open.mockResolvedValue(["/a/picked.txt"]);
    native.listen.mockResolvedValue(native.unlisten);
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("useAttachments async ownership", () => {
    it("captures A before the picker opens and merges into A's latest contents after switching to B", async () => {
        const dialog = deferred<string[] | null>();
        native.open.mockReturnValueOnce(dialog.promise);
        const { result, rerender, drafts, stageA, stageB, updates } = setup([
            attachment("a-removed"),
        ]);
        let pick!: Promise<void>;
        act(() => {
            pick = result.current.pick();
        });
        rerender({ target: "b", enabled: false });
        drafts.a = [attachment("a-added-while-picker-open")];
        await act(async () => {
            dialog.resolve(["/a/picked.txt"]);
            await pick;
        });
        expect(stageA).toHaveBeenCalledWith({ path: "/a/picked.txt" });
        expect(stageB).not.toHaveBeenCalled();
        expect(drafts.a?.map((a) => a.id)).toEqual(["a-added-while-picker-open", "a-picked"]);
        expect(drafts.b?.map((a) => a.id)).toEqual(["b-existing"]);
        expect(updates.a).toHaveBeenCalledWith(expect.any(Function));
        expect(updates.b).not.toHaveBeenCalled();
    });

    it("keeps an in-flight stage completion attached to its original draft", async () => {
        const stage = deferred<AttachmentStageResult>();
        const { result, rerender, drafts, stageA, updates } = setup();
        stageA.mockReturnValueOnce(stage.promise);
        let pick!: Promise<void>;
        act(() => {
            pick = result.current.pick();
        });
        await waitFor(() => expect(stageA).toHaveBeenCalledOnce());
        rerender({ target: "b", enabled: true });
        drafts.a = [attachment("concurrent-a")];
        await act(async () => {
            stage.resolve(attachment("late-a"));
            await pick;
        });
        expect(drafts.a?.map((a) => a.id)).toEqual(["concurrent-a", "late-a"]);
        expect(updates.b).not.toHaveBeenCalled();
    });

    it("merges concurrent picker completions without losing either result", async () => {
        const first = deferred<AttachmentStageResult>();
        const second = deferred<AttachmentStageResult>();
        const { result, stageA, drafts } = setup();
        stageA.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        let picks!: Promise<void>[];
        act(() => {
            picks = [result.current.pick(), result.current.pick()];
        });
        await waitFor(() => expect(stageA).toHaveBeenCalledTimes(2));
        await act(async () => {
            second.resolve(attachment("second"));
            await picks[1];
        });
        await act(async () => {
            first.resolve(attachment("first"));
            await picks[0];
        });
        expect(drafts.a?.map((a) => a.id)).toEqual(["second", "first"]);
    });

    it("does not open a picker or stage files when the captured composer is disabled", async () => {
        const { result, rerender, stageA } = setup();
        rerender({ target: "a", enabled: false });
        await act(async () => result.current.pick());
        expect(native.open).not.toHaveBeenCalled();
        expect(stageA).not.toHaveBeenCalled();
    });

    it("captures the drop target before staging and retains the registration cleanup", async () => {
        const stage = deferred<AttachmentStageResult>();
        const { rerender, drafts, stageA, stageB, unmount } = setup();
        stageA.mockReturnValueOnce(stage.promise);
        await waitFor(() => expect(native.listen).toHaveBeenCalledOnce());
        const listener = native.listen.mock.calls[0]?.[0] as (event: {
            payload: { type: string; paths: string[] };
        }) => void;
        act(() => listener({ payload: { type: "drop", paths: ["/a/drop.txt"] } }));
        rerender({ target: "b", enabled: true });
        await act(async () => {
            stage.resolve(attachment("dropped-a"));
        });
        await waitFor(() => expect(drafts.a?.map((a) => a.id)).toEqual(["dropped-a"]));
        expect(stageB).not.toHaveBeenCalled();
        unmount();
        expect(native.unlisten).toHaveBeenCalledOnce();
    });

    it("keeps pasted images owned by A through a switch and leaves accepted URL cleanup to the draft owner", async () => {
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:accepted");
        const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        const stage = deferred<AttachmentStageResult>();
        const { result, rerender, drafts, stageA, stageB, unmount } = setup();
        stageA.mockReturnValueOnce(stage.promise);
        const event = paste(new File(["image bytes"], "paste.png", { type: "image/png" }));
        act(() => result.current.handlePaste(event));
        rerender({ target: "b", enabled: true });
        await waitFor(() => expect(stageA).toHaveBeenCalledOnce());
        drafts.a = [attachment("a-concurrent")];
        await act(async () => {
            stage.resolve(attachment("pasted-a", "image"));
        });
        await waitFor(() => expect(drafts.a?.[1]?.previewUrl).toBe("blob:accepted"));
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(stageB).not.toHaveBeenCalled();
        rerender({ target: "a", enabled: true });
        act(() => result.current.removeAttachment(1));
        unmount();
        expect(revoke).not.toHaveBeenCalled();
        expect(drafts.a?.map((a) => a.id)).toEqual(["a-concurrent"]);
    });

    it.each(["rejected", "not-image", "too-many"] as const)(
        "revokes an unused pasted preview once (%s)",
        async (outcome) => {
            vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:unused");
            const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
            const { result, stageA, unmount } = setup(
                outcome === "too-many"
                    ? Array.from({ length: ATTACHMENT_MAX_COUNT }, (_, i) =>
                          attachment(`existing-${i}`),
                      )
                    : [],
            );
            if (outcome === "rejected") stageA.mockRejectedValueOnce(new Error("stage failed"));
            act(() =>
                result.current.handlePaste(
                    paste(new File(["bytes"], "a.png", { type: "image/png" })),
                ),
            );
            await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:unused"));
            unmount();
            expect(revoke).toHaveBeenCalledOnce();
        },
    );
});
