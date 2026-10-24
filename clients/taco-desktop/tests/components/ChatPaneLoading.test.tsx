/**
 * ChatPane while another session opens — the composer must be locked, not
 * just the send button: the draft is one shared field, so text or images added
 * now would be sent to the session being opened. Per-session settings (model,
 * thinking level) are locked for the same reason.
 */
import { strict as assert } from "node:assert";
import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, it, vi } from "vitest";

import { ToastProvider } from "../../src/components/ToastProvider";
import * as useI18n from "../../src/i18n/useI18n";
import type { WorkspaceState } from "../../src/lib/chat/workspaceReducer";
import { ChatPane, type ChatPaneProps } from "../../src/views/ChatPane";

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
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
