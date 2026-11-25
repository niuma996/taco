/**
 * ChatPane while another session opens — the composer must be locked, not
 * just the send button: the draft is one shared field, so text or images added
 * now would be sent to the session being opened. Per-session settings (model,
 * thinking level) are locked for the same reason.
 *
 * The second half of the file covers the user message guide: the rail of user
 * messages that indexes the session and jumps to a row.
 */
import { strict as assert } from "node:assert";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, it, vi } from "vitest";

import { ToastProvider } from "../../src/components/ToastProvider";
import * as useI18n from "../../src/i18n/useI18n";
import type { UiMessage } from "../../src/lib/chat/chatUtils";
import { createSessionState, type SessionState } from "../../src/lib/chat/sessionState";
import { createEmptyWorkspace, type WorkspaceState } from "../../src/lib/chat/workspaceReducer";
import { ChatPane, type ChatPaneProps } from "../../src/views/ChatPane";
import { queryWrapper } from "../helpers/queryWrapper";

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string, opts?: Record<string, unknown>) =>
        opts ? `${key} ${Object.values(opts).join(" ")}` : key,
} as unknown as ReturnType<typeof useI18n.useT>);

// The attachment hook registers a native drag-drop listener and opens the OS picker;
// neither exists under jsdom.
vi.mock("@tauri-apps/api/webview", () => ({
    getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));

// Children that reach for the client or global config; their own tests cover them.
vi.mock("../../src/components/CommandPermissionModeSelector", () => ({
    CommandPermissionModeSelector: () => null,
}));
vi.mock("../../src/components/SessionInfo", () => ({ SessionInfo: () => null }));
vi.mock("../../src/components/ContextIndicator", () => ({ ContextIndicator: () => null }));
// Surfaces the disabled prop the pane hands the model menu.
vi.mock("../../src/components/settings/ModelMenu", () => ({
    ModelMenu: ({ disabled }: { disabled?: boolean }) => (
        <button type="button" aria-label="model menu" disabled={disabled} />
    ),
}));

afterEach(cleanup);

function workspace(
    overrides: Partial<WorkspaceState>,
    sessionOverrides: Partial<SessionState> = {},
): WorkspaceState {
    return {
        ...createEmptyWorkspace("/ws", true),
        activeSession: "a",
        sessionStatesById: {
            a: {
                ...createSessionState(),
                messages: [{ id: "u1", kind: "user", text: "hello", ts: 1 }],
                ...sessionOverrides,
            },
        },
        ...overrides,
    };
}

function renderPane(
    ws: WorkspaceState | undefined,
    isIm = false,
    overrides: Partial<ChatPaneProps> = {},
) {
    const props: ChatPaneProps = {
        client: {
            gitInspect: () => new Promise(() => {}),
            gitInit: async () => ({ status: "not_repository" }),
        } as unknown as ChatPaneProps["client"],
        ws,
        isIm,
        checkpoints: [],
        onRestoreCheckpoint: async () => ({ ok: true }),
        input: "draft",
        attachments: [
            { id: "att-1", name: "shot.png", mimeType: "image/png", size: 1024, kind: "image" },
        ],
        onStageAttachment: async () => ({
            id: "att-2",
            name: "x.txt",
            mimeType: "text/plain",
            size: 1,
            kind: "file",
        }),
        busy: false,
        runInFlight: false,
        queuedItems: [],
        onCancelQueued: () => {},
        onInterruptAndSendQueued: async () => {},
        sidebarCollapsed: false,
        onToggleSidebar: () => {},
        compacting: false,
        contextIndicator: { info: null, loading: false },
        onInputChange: () => {},
        onAttachmentsChange: () => {},
        onSend: () => {},
        onAbort: () => {},
        onEnter: () => {},
        activeLevel: null,
        onLevelChange: () => {},
        activeModel: { provider: "p", id: "m" },
        onModelChange: () => {},
        modelOptions: [],
        textareaRef: createRef<HTMLTextAreaElement>(),
        onCopySessionId: () => {},
        copiedSessionId: null,
        onCommandPermission: () => {},
        ...overrides,
    };
    // Image attachments report validation failures through toasts.
    const view = render(
        <ToastProvider>
            <ChatPane {...props} />
        </ToastProvider>,
        { wrapper: queryWrapper().wrapper },
    );
    return {
        ...view,
        rerenderWorkspace(next: WorkspaceState) {
            view.rerender(
                <ToastProvider>
                    <ChatPane {...props} ws={next} />
                </ToastProvider>,
            );
        },
    };
}

describe("ChatPane composer while a session opens", () => {
    it("locks text, attaching, attachment removal, model and send", () => {
        renderPane(workspace({ loadingSessionId: "b" }));
        assert.equal(screen.getByRole("textbox").hasAttribute("disabled"), true);
        assert.equal(
            screen.getByRole("button", { name: "input.removeAttachment" }).hasAttribute("disabled"),
            true,
        );
        assert.equal(
            screen.getByRole("button", { name: "model menu" }).hasAttribute("disabled"),
            true,
        );
        assert.equal(
            screen.getByRole("button", { name: "input.send" }).hasAttribute("disabled"),
            true,
        );
        assert.equal(
            screen.getByRole("button", { name: "input.attachFiles" }).hasAttribute("disabled"),
            true,
        );
    });

    it("unlocks once the session has opened", () => {
        renderPane(workspace({}));
        assert.equal(screen.getByRole("textbox").hasAttribute("disabled"), false);
        assert.equal(
            screen.getByRole("button", { name: "input.removeAttachment" }).hasAttribute("disabled"),
            false,
        );
        assert.equal(
            screen.getByRole("button", { name: "model menu" }).hasAttribute("disabled"),
            false,
        );
        assert.equal(
            screen.getByRole("button", { name: "input.send" }).hasAttribute("disabled"),
            false,
        );
    });
});

describe("ChatPane running turn controls", () => {
    it("keeps icon-only Stop for an empty composer without a steer queue", () => {
        const onAbort = vi.fn();
        renderPane(workspace({}), false, {
            busy: true,
            runInFlight: true,
            input: "",
            attachments: [],
            onAbort,
        });
        assert.equal(Boolean(screen.queryByText("input.steerHint")), false);
        assert.equal(screen.getByRole("textbox").hasAttribute("aria-describedby"), false);
        assert.equal(
            Boolean(screen.queryByRole("button", { name: "input.interruptReply" })),
            false,
        );
        assert.equal(
            Boolean(screen.queryByRole("button", { name: /input.interruptAndSendQueued/ })),
            false,
        );
        fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
        assert.equal(onAbort.mock.calls.length, 0);
        fireEvent.click(screen.getByRole("button", { name: "input.stop" }));
        assert.equal(onAbort.mock.calls.length, 1);
    });

    it("keeps batch sending, submitting a draft and removing a queued message separate", () => {
        const onAbort = vi.fn();
        const onSend = vi.fn();
        const onEnter = vi.fn();
        const onCancelQueued = vi.fn();
        const item = { id: "queued-1", kind: "steer", text: "Extra guidance" } as const;
        renderPane(workspace({}), false, {
            busy: true,
            runInFlight: true,
            queuedItems: [item],
            onAbort,
            onSend,
            onEnter,
            onCancelQueued,
        });
        const input = screen.getByRole<HTMLTextAreaElement>("textbox");
        assert.equal(Boolean(screen.queryByText("input.steerHint")), false);
        assert.equal(input.hasAttribute("aria-describedby"), false);
        assert.ok(screen.getByText("queue.pendingCurrentTurn"));
        assert.ok(screen.getByText(item.text));
        fireEvent.click(screen.getByRole("button", { name: "queue.cancel" }));
        assert.deepEqual(onCancelQueued.mock.calls, [[item]]);
        assert.equal(onAbort.mock.calls.length, 0);

        assert.equal(
            Boolean(screen.queryByRole("button", { name: "input.interruptReply" })),
            false,
        );
        assert.equal(input.value, "draft");

        fireEvent.click(screen.getByRole("button", { name: "input.sendSteer" }));
        fireEvent.keyDown(input, { key: "Enter" });
        assert.equal(onSend.mock.calls.length, 1);
        assert.equal(onEnter.mock.calls.length, 1);
        assert.equal(onAbort.mock.calls.length, 0);
    });

    it.each(["Enter", "composer button", "queue button"])(
        "interrupts and sends the confirmed steer batch with %s",
        (trigger) => {
            const onInterruptAndSendQueued = vi.fn(async () => {});
            const onAbort = vi.fn();
            const onEnter = vi.fn();
            const onSend = vi.fn();
            renderPane(workspace({}), false, {
                busy: true,
                runInFlight: true,
                input: "",
                attachments: [],
                queuedItems: [
                    { id: "one", kind: "steer", text: "first" },
                    { id: "later", kind: "followUp", text: "later" },
                    { id: "two", kind: "steer", text: "second" },
                    { id: "next", kind: "nextRun", text: "next run" },
                ],
                onInterruptAndSendQueued,
                onAbort,
                onEnter,
                onSend,
            });
            const input = screen.getByRole("textbox");
            fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
            fireEvent.keyDown(input, { key: "Enter", isComposing: true });
            fireEvent.keyDown(input, { key: "Enter", repeat: true });
            assert.equal(onInterruptAndSendQueued.mock.calls.length, 0);

            const queueButton = screen.getByRole("button", {
                name: "input.interruptAndSendQueued",
            });
            const composerButton = screen.getByRole("button", { name: "input.interruptAndSend" });
            assert.equal(composerButton.hasAttribute("disabled"), false);
            assert.equal(
                input.getAttribute("aria-describedby"),
                screen.getByText("input.steerHint").id,
            );
            if (trigger === "Enter") fireEvent.keyDown(input, { key: "Enter" });
            else fireEvent.click(trigger === "composer button" ? composerButton : queueButton);
            assert.deepEqual(onInterruptAndSendQueued.mock.calls, [[["one", "two"]]]);

            fireEvent.keyDown(input, { key: "Enter" });
            fireEvent.click(composerButton);
            fireEvent.click(queueButton);
            assert.equal(
                onInterruptAndSendQueued.mock.calls.length,
                1,
                "guards an in-flight batch",
            );
            assert.equal(
                onAbort.mock.calls.length + onEnter.mock.calls.length + onSend.mock.calls.length,
                0,
            );
        },
    );

    it("waits until the whole steer batch has been queued", () => {
        const onInterruptAndSendQueued = vi.fn(async () => {});
        renderPane(workspace({}), false, {
            runInFlight: true,
            input: "",
            attachments: [],
            queuedItems: [
                { id: "one", kind: "steer", text: "first" },
                { id: "staging", kind: "steer", text: "staging", optimistic: true },
            ],
            onInterruptAndSendQueued,
        });
        const button = screen.getByRole("button", { name: "input.interruptAndSendQueued" });
        assert.equal(button.hasAttribute("disabled"), true);
        const composerButton = screen.getByRole("button", { name: "input.interruptAndSend" });
        assert.equal(composerButton.hasAttribute("disabled"), true);
        assert.equal(Boolean(screen.queryByRole("button", { name: "input.stop" })), false);
        assert.equal(Boolean(screen.queryByText("input.steerHint")), false);
        fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
        fireEvent.click(composerButton);
        assert.equal(onInterruptAndSendQueued.mock.calls.length, 0);
    });

    it("shows why batch sending is unavailable on an older service", () => {
        const onAbort = vi.fn();
        const onEnter = vi.fn();
        renderPane(workspace({}), false, {
            busy: true,
            runInFlight: true,
            input: "",
            attachments: [],
            queuedItems: [{ id: "one", kind: "steer", text: "first" }],
            onInterruptAndSendQueued: undefined,
            onAbort,
            onEnter,
        });
        const button = screen.getByRole("button", { name: "input.interruptAndSendQueued" });
        assert.equal(button.hasAttribute("disabled"), true);
        assert.ok(screen.getByText("input.steerUnavailable"));
        assert.equal(Boolean(screen.queryByText("input.steerHint")), false);
        fireEvent.click(button);
        fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
        assert.equal(onAbort.mock.calls.length + onEnter.mock.calls.length, 0);
        fireEvent.click(screen.getByRole("button", { name: "input.stop" }));
        assert.equal(onAbort.mock.calls.length, 1);
    });

    it("offers a batch button without submitting an existing attachment draft", () => {
        const onInterruptAndSendQueued = vi.fn(async () => {});
        const onEnter = vi.fn();
        renderPane(workspace({}), false, {
            busy: true,
            runInFlight: true,
            input: "",
            queuedItems: [{ id: "one", kind: "steer", text: "first" }],
            onInterruptAndSendQueued,
            onEnter,
        });
        const input = screen.getByRole("textbox");
        assert.equal(Boolean(screen.queryByText("input.steerHint")), false);
        assert.equal(input.hasAttribute("aria-describedby"), false);
        fireEvent.keyDown(input, { key: "Enter" });
        assert.equal(onEnter.mock.calls.length, 1);
        assert.equal(onInterruptAndSendQueued.mock.calls.length, 0);
        fireEvent.click(screen.getByRole("button", { name: "input.interruptAndSendQueued" }));
        assert.deepEqual(onInterruptAndSendQueued.mock.calls, [[["one"]]]);
    });

    it.each([
        { state: "idle", busy: false, runInFlight: false, compacting: false },
        { state: "compacting", busy: true, runInFlight: true, compacting: true },
        { state: "background agent", busy: true, runInFlight: false, compacting: false },
        { state: "opening a chat", busy: true, runInFlight: true, compacting: false },
    ])("shows only the appropriate controls when $state", ({ state, ...flags }) => {
        const loading = state === "opening a chat";
        renderPane(workspace(loading ? { loadingSessionId: "b" } : {}), false, {
            ...flags,
            input: "",
            attachments: [],
        });
        assert.equal(
            Boolean(screen.queryByRole("button", { name: "input.interruptReply" })),
            false,
        );
        assert.equal(Boolean(screen.queryByText("input.steerHint")), false);
        assert.equal(
            Boolean(screen.queryByRole("button", { name: "input.stop" })),
            flags.busy && !loading,
        );
    });
});

describe("ChatPane synchronization status", () => {
    it("distinguishes known transcript retention from failed synchronization", () => {
        renderPane(
            workspace({
                sessionStatesById: {
                    a: {
                        ...createSessionState(),
                        sync: "current",
                        execution: "idle",
                        historyLoaded: true,
                        truncated: true,
                    },
                },
            }),
        );
        assert.ok(screen.getByText("input.historyTruncated"));
        assert.equal(screen.queryByText("input.stateSyncIncomplete"), null);
        assert.equal(screen.queryByText("input.executionUnknown"), null);
    });

    it("reports unknown execution independently of a caught-up transcript", () => {
        renderPane(
            workspace({
                sessionStatesById: {
                    a: { ...createSessionState(), sync: "current", historyLoaded: true },
                },
            }),
        );
        assert.ok(screen.getByText("input.executionUnknown"));
        assert.equal(screen.queryByText("input.stateSyncIncomplete"), null);
    });

    it("shows an incomplete replay immediately", () => {
        renderPane(
            workspace({
                sessionStatesById: { a: { ...createSessionState(), sync: "incomplete" } },
            }),
        );
        assert.ok(screen.getByText("input.stateSyncIncomplete"));
        assert.equal(screen.queryByText("input.executionUnknown"), null);
    });

    it("delays the recovering notice and removes it as soon as recovery ends", async () => {
        vi.useFakeTimers();
        try {
            const view = renderPane(workspace({ sessionStatesById: { a: createSessionState() } }));
            assert.equal(screen.queryByText("input.stateSyncIncomplete"), null);
            assert.equal(screen.queryByText("input.stateSyncRecovering"), null);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(350);
            });
            assert.ok(screen.getByText("input.stateSyncRecovering"));
            view.rerenderWorkspace(
                workspace({
                    sessionStatesById: {
                        a: { ...createSessionState(), sync: "current", execution: "idle" },
                    },
                }),
            );
            assert.equal(screen.queryByText("input.stateSyncRecovering"), null);
            view.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it("never flashes a notice for a fast recovery", async () => {
        vi.useFakeTimers();
        try {
            const view = renderPane(workspace({ sessionStatesById: { a: createSessionState() } }));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(100);
            });
            view.rerenderWorkspace(
                workspace({
                    sessionStatesById: {
                        a: { ...createSessionState(), sync: "current", execution: "idle" },
                    },
                }),
            );
            await act(async () => {
                await vi.advanceTimersByTimeAsync(500);
            });
            assert.equal(screen.queryByText("input.stateSyncRecovering"), null);
            assert.equal(screen.queryByText("input.stateSyncIncomplete"), null);
            view.unmount();
        } finally {
            vi.useRealTimers();
        }
    });
});

/**
 * A conversation of `turns` user prompts. The assistant replies are empty, so
 * their rows render nothing and the fixture stays cheap — only the user rows
 * carry a navigation target anyway.
 */
function conversation(turns: number): UiMessage[] {
    const messages: UiMessage[] = [];
    for (let i = 0; i < turns; i++) {
        messages.push({ id: `u${i}`, kind: "user", text: `prompt ${i}`, ts: i + 1 });
        messages.push({
            id: `a${i}`,
            kind: "assistant",
            text: "",
            ts: i + 1,
            tools: [],
            thinking: [],
        });
    }
    return messages;
}

/** Height of the faked viewport. */
const VIEWPORT_HEIGHT = 100;
/** Row height of the faked layout. */
const ROW_HEIGHT = 20;

/** happy-dom does no layout, so the chat column gets a geometry of its own. */
function stubGeometry(main: HTMLElement): void {
    const setRect = (el: HTMLElement, top: number, height: number): void => {
        el.getBoundingClientRect = (() => ({
            top,
            bottom: top + height,
            height,
            left: 0,
            right: 100,
            width: 100,
            x: 0,
            y: top,
            toJSON: () => ({}),
        })) as typeof el.getBoundingClientRect;
    };
    setRect(main, 0, VIEWPORT_HEIGHT);
    main.querySelectorAll<HTMLElement>("[data-message-id]").forEach((row, i) => {
        setRect(row, i * ROW_HEIGHT, ROW_HEIGHT);
    });
}

/** The chat column — the scroll container the guide jumps inside. */
function chatColumn(): HTMLElement {
    const main = document.querySelector("main");
    assert.ok(main);
    return main;
}

describe("ChatPane 用户消息导轨", () => {
    it("有用户消息的会话渲染导轨但不渲染可见计数", () => {
        renderPane(workspace({}, { messages: conversation(2) }));
        assert.equal(screen.queryByTestId("user-message-count"), null);
        assert.ok(screen.getByTestId("user-message-rail"));
        assert.ok(screen.getByText("message.guideCountValue 2"));
    });

    it("空会话不渲染导轨", () => {
        renderPane(workspace({}, { messages: [] }));
        assert.equal(screen.queryByTestId("user-message-rail"), null);
        assert.equal(screen.queryByTestId("user-message-count"), null);
    });

    it("加载骨架屏时不渲染导轨", async () => {
        renderPane(workspace({ loadingSessionId: "b" }, { messages: conversation(2) }));
        await waitFor(() => assert.ok(document.querySelector(".chat-skeleton")));
        assert.equal(screen.queryByTestId("user-message-rail"), null);
    });

    it("点击未挂载的条目会展开窗口并滚动到那条消息", async () => {
        const scrollIntoView = vi
            .spyOn(Element.prototype, "scrollIntoView")
            .mockImplementation(() => {});
        try {
            renderPane(workspace({}, { messages: conversation(30) }));
            stubGeometry(chatColumn());
            // The render window dropped the head of the conversation.
            assert.equal(document.querySelectorAll("[data-message-id]").length, 20);

            fireEvent.click(screen.getByRole("button", { name: "message.guideItem 1" }));

            await waitFor(() => assert.equal(scrollIntoView.mock.calls.length, 1));
            assert.deepEqual(scrollIntoView.mock.calls[0], [
                { block: "center", behavior: "instant" },
            ]);
            const target = scrollIntoView.mock.instances[0] as HTMLElement;
            assert.equal(target.dataset.messageId, "u0");
            // The revealed row is mounted and carries the landing marker.
            const row = document.querySelector('[data-message-id="u0"]');
            assert.ok(row);
            assert.equal(row.classList.contains("message--navigation-target"), true);
        } finally {
            scrollIntoView.mockRestore();
        }
    });

    it("跳转目标被标为高亮行，导轨把它标为当前项", () => {
        renderPane(workspace({}, { messages: conversation(2) }));
        fireEvent.click(screen.getByRole("button", { name: "message.guideItem 2" }));
        const row = document.querySelector('[data-message-id="u1"]');
        assert.ok(row);
        assert.equal(row.classList.contains("message--navigation-target"), true);
        assert.equal(
            screen
                .getByRole("button", { name: "message.guideItem 2" })
                .getAttribute("aria-current"),
            "location",
        );
    });
});

describe("empty workspace composer", () => {
    it("disables input after the last workspace is removed", () => {
        renderPane(undefined);
        assert.equal((screen.getByRole("textbox") as HTMLTextAreaElement).disabled, true);
    });
});

describe("local workspace Git footer", () => {
    it("places Git status below the input card and hides it for IM", () => {
        renderPane(workspace({}));
        const footer = document.querySelector("footer.input");
        assert.ok(footer?.querySelector(".composer-dock > .composer-input-stack"));
        assert.ok(footer?.querySelector(".composer-input-stack > .input-card"));
        assert.equal(footer?.querySelector(".composer-frost"), null);
        assert.ok(
            footer?.querySelector(".composer-dock > .composer-input-stack + .workspace-git-status"),
        );
        cleanup();
        renderPane(workspace({}), true);
        assert.equal(document.querySelector(".workspace-git-status"), null);
    });
});
