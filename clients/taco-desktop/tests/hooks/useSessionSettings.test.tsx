import type { ThinkingLevel } from "@taco-ai/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "../../src/components/settings/ModelPicker";
import { useSessionSettings } from "../../src/hooks/useSessionSettings";
import type { TacoClient } from "../../src/lib/clients/tacoClient";

vi.mock("../../src/lib/globalConfig", () => ({
    getGlobalConfig: () => ({ global: {} }),
    defaultThinkingLevelForNewSession: () => "medium",
}));

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

const model = (id: string): ModelSelection => ({ provider: "provider", id });

function setup() {
    const setModel = vi.fn(async (_params: unknown) => {});
    const setLevel = vi.fn(async (_params: unknown) => {});
    const notify = vi.fn();
    const hook = renderHook(
        (props: { workspace: string; sessionId: string | undefined; draftId: string }) =>
            useSessionSettings({
                client: {
                    sessionSetModel: setModel,
                    sessionSetThinkingLevel: setLevel,
                } as unknown as TacoClient,
                activeCwd: props.workspace,
                activeSession: props.sessionId,
                activeDraftId: props.draftId,
                pushNotification: notify,
            }),
        {
            initialProps: {
                workspace: "/a",
                sessionId: "shared" as string | undefined,
                draftId: "draft-a",
            },
        },
    );
    return { ...hook, setModel, setLevel, notify };
}

describe("useSessionSettings ownership", () => {
    it("separates models and thinking levels for the same session id in different workspaces", async () => {
        const { result, rerender } = setup();
        await act(async () => {
            await result.current.setSessionModel(model("a"));
            await result.current.setSessionLevel("off");
        });
        rerender({ workspace: "/b", sessionId: "shared", draftId: "draft-b" });
        expect(result.current.activeModel).toBeNull();
        expect(result.current.activeLevel).toBe("medium");
        expect(result.current.isThinkingSuppressed("shared", "/a")).toBe(true);
        expect(result.current.isThinkingSuppressed("shared")).toBe(false);
        await act(async () => {
            await result.current.setSessionModel(model("b"));
            await result.current.setSessionLevel("high");
        });
        rerender({ workspace: "/a", sessionId: "shared", draftId: "draft-a" });
        expect(result.current.activeModel).toEqual(model("a"));
        expect(result.current.activeLevel).toBe("off");
        expect(result.current.isThinkingSuppressed("shared")).toBe(true);
    });

    it("keeps staged model choices per workspace and draft, and clears only the requested draft", async () => {
        const { result, rerender } = setup();
        rerender({ workspace: "/a", sessionId: undefined, draftId: "draft-a" });
        await act(async () => result.current.setSessionModel(model("a")));
        const defaultsA = result.current.newSessionDefaults();
        const clearA = result.current.clearStagedModel;
        rerender({ workspace: "/a", sessionId: undefined, draftId: "draft-b" });
        expect(result.current.activeModel).toBeNull();
        await act(async () => result.current.setSessionModel(model("b")));
        rerender({ workspace: "/b", sessionId: undefined, draftId: "draft-a" });
        expect(result.current.activeModel).toBeNull();
        await act(async () => result.current.setSessionModel(model("other-workspace")));
        expect(result.current.newSessionDefaults({ workspace: "/a", draftId: "draft-a" })).toEqual(
            defaultsA,
        );
        act(() => clearA());
        expect(result.current.activeModel).toEqual(model("other-workspace"));
        expect(
            result.current.newSessionDefaults({ workspace: "/a", draftId: "draft-a" }).initialModel,
        ).toBeNull();
        expect(
            result.current.newSessionDefaults({ workspace: "/a", draftId: "draft-b" }).initialModel,
        ).toEqual(model("b"));
    });

    it("adopts delayed creation into the original workspace and draft only", async () => {
        const { result, rerender } = setup();
        rerender({ workspace: "/a", sessionId: undefined, draftId: "draft-a" });
        await act(async () => result.current.setSessionModel(model("a")));
        const defaults = result.current.newSessionDefaults();
        rerender({ workspace: "/b", sessionId: undefined, draftId: "draft-b" });
        await act(async () => result.current.setSessionModel(model("b")));
        act(() =>
            result.current.adoptNewSession("created", defaults, {
                workspace: "/a",
                draftId: "draft-a",
            }),
        );
        expect(result.current.activeModel).toEqual(model("b"));
        expect(
            result.current.newSessionDefaults({ workspace: "/a", draftId: "draft-a" }).initialModel,
        ).toBeNull();
        rerender({ workspace: "/a", sessionId: "created", draftId: "draft-a" });
        expect(result.current.activeModel).toEqual(model("a"));
        expect(result.current.activeLevel).toBe("medium");
    });

    it("preserves a newer staged pick when adopting the defaults captured before it", async () => {
        const { result, rerender } = setup();
        rerender({ workspace: "/a", sessionId: undefined, draftId: "draft-a" });
        await act(async () => result.current.setSessionModel(model("old")));
        const defaults = result.current.newSessionDefaults();
        await act(async () => result.current.setSessionModel(model("new")));
        act(() => result.current.adoptNewSession("created", defaults));
        expect(result.current.activeModel).toEqual(model("new"));
        rerender({ workspace: "/a", sessionId: "created", draftId: "draft-a" });
        expect(result.current.activeModel).toEqual(model("old"));
    });

    it("binds saved setters to their render target and supports explicit session targets", async () => {
        const { result, rerender, setModel, setLevel } = setup();
        const setA = result.current.setSessionModel;
        const levelA = result.current.setSessionLevel;
        rerender({ workspace: "/b", sessionId: "b", draftId: "draft-b" });
        await act(async () => {
            await setA(model("a"));
            await levelA("off");
            await result.current.setSessionModel(model("explicit"), {
                workspace: "/c",
                sessionId: "c",
            });
            await result.current.setSessionLevel("high", { workspace: "/c", sessionId: "c" });
        });
        expect(setModel.mock.calls[0]?.[0]).toMatchObject({ workspace: "/a", sessionId: "shared" });
        expect(setLevel.mock.calls[0]?.[0]).toMatchObject({ workspace: "/a", sessionId: "shared" });
        expect(setModel.mock.calls[1]?.[0]).toMatchObject({ workspace: "/c", sessionId: "c" });
        expect(result.current.activeModel).toBeNull();
        expect(result.current.isThinkingSuppressed("shared", "/a")).toBe(true);
        rerender({ workspace: "/c", sessionId: "c", draftId: "draft-c" });
        expect(result.current.activeModel).toEqual(model("explicit"));
        expect(result.current.activeLevel).toBe("high");
    });

    for (const kind of ["model", "level"] as const) {
        it(`does not roll back a newer ${kind} pick when an earlier RPC fails`, async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const { result, rerender, setModel, setLevel, notify } = setup();
            const pending = deferred();
            (kind === "model" ? setModel : setLevel).mockImplementationOnce(() => pending.promise);
            let first!: Promise<void>;
            act(() => {
                first =
                    kind === "model"
                        ? result.current.setSessionModel(model("old"))
                        : result.current.setSessionLevel("off");
            });
            rerender({ workspace: "/b", sessionId: "shared", draftId: "draft-b" });
            rerender({ workspace: "/a", sessionId: "shared", draftId: "draft-a" });
            await act(async () => {
                if (kind === "model") await result.current.setSessionModel(model("new"));
                else await result.current.setSessionLevel("high");
            });
            await act(async () => {
                pending.reject(new Error("old failed"));
                await first;
            });
            expect(
                kind === "model" ? result.current.activeModel : result.current.activeLevel,
            ).toEqual(kind === "model" ? model("new") : "high");
            expect(notify).toHaveBeenCalledWith(expect.stringContaining("old failed"));
        });
    }

    for (const kind of ["model", "level"] as const) {
        it(`protects a newer identical ${kind} pick with a version rather than value equality`, async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const { result, setModel, setLevel } = setup();
            const pending = deferred();
            const sameModel = model("same");
            (kind === "model" ? setModel : setLevel).mockImplementationOnce(() => pending.promise);
            let first!: Promise<void>;
            act(() => {
                first =
                    kind === "model"
                        ? result.current.setSessionModel(sameModel)
                        : result.current.setSessionLevel("off");
            });
            await act(async () => {
                if (kind === "model") await result.current.setSessionModel(sameModel);
                else await result.current.setSessionLevel("off");
            });
            await act(async () => {
                pending.reject(new Error("earlier identical pick failed"));
                await first;
            });
            expect(
                kind === "model" ? result.current.activeModel : result.current.activeLevel,
            ).toEqual(kind === "model" ? sameModel : "off");
        });
    }

    it("rolls back to the immediately preceding pick even when calls share one render", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { result, setModel } = setup();
        const pending = deferred();
        setModel
            .mockImplementationOnce(async () => {})
            .mockImplementationOnce(() => pending.promise);
        let second!: Promise<void>;
        await act(async () => {
            const set = result.current.setSessionModel;
            const first = set(model("first"));
            second = set(model("second"));
            await first;
        });
        await act(async () => {
            pending.reject(new Error("second failed"));
            await second;
        });
        expect(result.current.activeModel).toEqual(model("first"));
    });

    it("rolls back the original workspace without disturbing the selected workspace", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { result, rerender, setLevel } = setup();
        await act(async () => result.current.setSessionLevel("low"));
        const pending = deferred();
        setLevel.mockImplementationOnce(() => pending.promise);
        let change!: Promise<void>;
        act(() => {
            change = result.current.setSessionLevel("off");
        });
        rerender({ workspace: "/b", sessionId: "shared", draftId: "draft-b" });
        await act(async () => result.current.setSessionLevel("high"));
        await act(async () => {
            pending.reject(new Error("failed"));
            await change;
        });
        expect(result.current.activeLevel).toBe("high");
        rerender({ workspace: "/a", sessionId: "shared", draftId: "draft-a" });
        expect(result.current.activeLevel).toBe("low" satisfies ThinkingLevel);
    });
});
