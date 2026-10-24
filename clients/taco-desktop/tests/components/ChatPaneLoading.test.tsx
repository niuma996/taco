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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, it, vi } from "vitest";

import { ToastProvider } from "../../src/components/ToastProvider";
import * as useI18n from "../../src/i18n/useI18n";
import type { UiMessage } from "../../src/lib/chat/chatUtils";
import type { WorkspaceState } from "../../src/lib/chat/workspaceReducer";
import { ChatPane, type ChatPaneProps } from "../../src/views/ChatPane";

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string, opts?: Record<string, unknown>) =>
        opts ? `${key} ${Object.values(opts).join(" ")}` : key,
} as unknown as ReturnType<typeof useI18n.useT>);

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

function workspace(overrides: Partial<WorkspaceState>): WorkspaceState {
    return {
        cwd: "/ws",
        active: true,
        sessions: [],
        messages: [{ id: "u1", kind: "user", text: "hello", ts: 1 }],
        subagentSpawned: {},
        childMessagesBySubSessionId: {},
        childHistoryLoaded: {},
        askUserPending: {},
        pendingCommandPermissions: {},
        agentToolPending: {},
        backgroundSubagents: {},
        pendingBySessionId: {},
        queuedBySessionId: {},
        taskSnapshotsBySessionId: {},
        planStatesBySessionId: {},
        historyDetailsBySessionId: {},
        activeSession: "a",
        ...overrides,
    };
}

function renderPane(ws: WorkspaceState) {
    const props: ChatPaneProps = {
        client: {} as ChatPaneProps["client"],
        ws,
        input: "draft",
        attachments: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
        busy: false,
        runInFlight: false,
        queuedItems: [],
        onCancelQueued: () => {},
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
    };
    // Image attachments report validation failures through toasts.
    return render(
        <ToastProvider>
            <ChatPane {...props} />
        </ToastProvider>,
    );
}

describe("ChatPane composer while a session opens", () => {
    it("locks text, images, attachment removal, model and send", () => {
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
        // The image picker is the one control with no accessible name of its own.
        const picker = document.querySelector("input[type=file]")?.nextElementSibling;
        assert.equal(picker?.hasAttribute("disabled"), true);
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
    it("有用户消息的会话渲染导轨和计数", () => {
        renderPane(workspace({ messages: conversation(2) }));
        assert.equal(screen.getByTestId("user-message-count").textContent, "2");
        assert.ok(screen.getByTestId("user-message-rail"));
    });

    it("空会话不渲染导轨", () => {
        renderPane(workspace({ messages: [] }));
        assert.equal(screen.queryByTestId("user-message-rail"), null);
        assert.equal(screen.queryByTestId("user-message-count"), null);
    });

    it("加载骨架屏时不渲染导轨", async () => {
        renderPane(workspace({ loadingSessionId: "b", messages: conversation(2) }));
        await waitFor(() => assert.ok(document.querySelector(".chat-skeleton")));
        assert.equal(screen.queryByTestId("user-message-rail"), null);
    });

    it("点击未挂载的条目会展开窗口并滚动到那条消息", async () => {
        const scrollIntoView = vi
            .spyOn(Element.prototype, "scrollIntoView")
            .mockImplementation(() => {});
        try {
            renderPane(workspace({ messages: conversation(30) }));
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
        renderPane(workspace({ messages: conversation(2) }));
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
