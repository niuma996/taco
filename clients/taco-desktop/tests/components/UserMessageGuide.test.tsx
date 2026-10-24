/**
 * UserMessageGuide — the left rail of user-message markers.
 *
 * Covers the entry count, the roving-tabindex keyboard loop, the hover
 * preview (text, images, truncation) and the rail's own scroll correction
 * when the active marker sits outside the visible band.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserMessageGuide } from "../../src/components/UserMessageGuide";
import * as useI18n from "../../src/i18n/useI18n";
import type { UserMessageGuideEntry } from "../../src/lib/chat/userMessageGuide";

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string, opts?: Record<string, unknown>) =>
        opts ? `${key} ${Object.values(opts).join(" ")}` : key,
} as unknown as ReturnType<typeof useI18n.useT>);

afterEach(cleanup);

const IMAGE = { type: "image", data: "QUJD", mimeType: "image/png" } as const;

const ENTRIES: UserMessageGuideEntry[] = [
    { id: "u1", messageIndex: 1, text: "hello", images: [] },
    { id: "u2", messageIndex: 2, text: "", images: [IMAGE] },
    { id: "u3", messageIndex: 3, text: "after", images: [] },
];

function marker(index: number): HTMLElement {
    return screen.getByRole("button", { name: `message.guideItem ${index}` });
}

/** Give the rail and one marker a layout happy-dom does not compute. */
function stubGeometry(
    rail: HTMLElement,
    markerEl: HTMLElement,
    geo: { scrollTop: number; clientHeight: number; offsetTop: number; offsetHeight: number },
): void {
    Object.defineProperty(rail, "clientHeight", { configurable: true, value: geo.clientHeight });
    Object.defineProperty(markerEl, "offsetTop", { configurable: true, value: geo.offsetTop });
    Object.defineProperty(markerEl, "offsetHeight", {
        configurable: true,
        value: geo.offsetHeight,
    });
    rail.scrollTop = geo.scrollTop;
}

describe("UserMessageGuide — 计数与当前项", () => {
    it("显示用户消息总数", () => {
        render(<UserMessageGuide entries={ENTRIES} activeId="u2" onNavigate={vi.fn()} />);
        expect(screen.getByTestId("user-message-count").textContent).toBe("3");
    });

    it("向读屏软件说明计数含义", () => {
        render(<UserMessageGuide entries={ENTRIES} activeId="u2" onNavigate={vi.fn()} />);
        // The visible count stays the plain number.
        expect(screen.getByTestId("user-message-count").textContent).toBe("3");
        // The meaning of the number is available to assistive technology.
        expect(screen.getByText("message.guideCountValue 3")).toBeTruthy();
    });

    it("只给当前项打上 aria-current", () => {
        render(<UserMessageGuide entries={ENTRIES} activeId="u2" onNavigate={vi.fn()} />);
        expect(marker(2).getAttribute("aria-current")).toBe("location");
        expect(marker(1).getAttribute("aria-current")).toBeNull();
        expect(marker(3).getAttribute("aria-current")).toBeNull();
    });

    it("没有当前项时没有任何 aria-current", () => {
        render(<UserMessageGuide entries={ENTRIES} onNavigate={vi.fn()} />);
        expect(marker(1).getAttribute("aria-current")).toBeNull();
        expect(marker(2).getAttribute("aria-current")).toBeNull();
    });
});

describe("UserMessageGuide — 键盘交互", () => {
    it("方向键移动焦点，Enter 触发跳转", async () => {
        const onNavigate = vi.fn();
        render(<UserMessageGuide entries={ENTRIES} activeId="u2" onNavigate={onNavigate} />);

        fireEvent.keyDown(marker(2), { key: "ArrowDown" });
        expect(document.activeElement?.getAttribute("aria-label")).toBe("message.guideItem 3");

        fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });
        expect(onNavigate.mock.calls[0]?.[0].id).toBe("u3");
        await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    });

    it("ArrowUp 与 Home / End 在首尾移动焦点", () => {
        render(<UserMessageGuide entries={ENTRIES} activeId="u2" onNavigate={vi.fn()} />);

        fireEvent.keyDown(marker(2), { key: "ArrowUp" });
        expect(document.activeElement?.getAttribute("aria-label")).toBe("message.guideItem 1");

        fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
        expect(document.activeElement?.getAttribute("aria-label")).toBe("message.guideItem 3");

        fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
        expect(document.activeElement?.getAttribute("aria-label")).toBe("message.guideItem 1");
    });

    it("在末尾继续按 ArrowDown 停在最后一个标记", () => {
        render(<UserMessageGuide entries={ENTRIES} activeId="u3" onNavigate={vi.fn()} />);

        fireEvent.keyDown(marker(3), { key: "ArrowDown" });
        expect(document.activeElement?.getAttribute("aria-label")).toBe("message.guideItem 3");
    });

    it("点击标记触发跳转", () => {
        const onNavigate = vi.fn();
        render(<UserMessageGuide entries={ENTRIES} activeId="u2" onNavigate={onNavigate} />);

        fireEvent.click(marker(3));
        expect(onNavigate.mock.calls[0]?.[0].id).toBe("u3");
    });

    it("条目变少后仍然保留一个 Tab 停靠点", () => {
        const many: UserMessageGuideEntry[] = Array.from({ length: 10 }, (_, i) => ({
            id: `u${i}`,
            messageIndex: i,
            text: "",
            images: [],
        }));
        const { rerender } = render(<UserMessageGuide entries={many} onNavigate={vi.fn()} />);
        // The focus walked to the last marker of the long list.
        fireEvent.keyDown(marker(1), { key: "End" });
        expect(marker(10).getAttribute("tabindex")).toBe("0");

        // A shorter session replaces the list, and no message is active.
        rerender(<UserMessageGuide entries={ENTRIES} onNavigate={vi.fn()} />);
        const tabbable = screen
            .getAllByRole("button")
            .filter((button) => button.getAttribute("tabindex") === "0");
        expect(tabbable).toHaveLength(1);
    });
});

describe("UserMessageGuide — 悬停预览", () => {
    it("预览保留原始多行文本", async () => {
        const user = userEvent.setup();
        const entries: UserMessageGuideEntry[] = [
            { id: "u1", messageIndex: 0, text: "line one\nline two", images: [] },
        ];
        render(<UserMessageGuide entries={entries} onNavigate={vi.fn()} />);

        await user.hover(marker(1));
        const preview = await screen.findByTestId("user-message-preview-u1");
        expect(within(preview).getByTestId("user-message-preview-text").textContent).toBe(
            "line one\nline two",
        );
        expect(within(preview).queryByTestId("user-message-preview-notice")).toBeNull();
    });

    it("图片消息显示图片占位和图片数量", async () => {
        const user = userEvent.setup();
        render(<UserMessageGuide entries={ENTRIES} onNavigate={vi.fn()} />);

        await user.hover(marker(2));
        const preview = await screen.findByTestId("user-message-preview-u2");
        expect(within(preview).getByTestId("user-message-preview-fallback").textContent).toBe(
            "message.guideImageOnly",
        );
        expect(within(preview).getByTestId("user-message-preview-image-count").textContent).toBe(
            "message.guideImageCount 1",
        );
    });

    it("空消息显示空占位", async () => {
        const user = userEvent.setup();
        const entries: UserMessageGuideEntry[] = [
            { id: "u1", messageIndex: 0, text: "", images: [] },
        ];
        render(<UserMessageGuide entries={entries} onNavigate={vi.fn()} />);

        await user.hover(marker(1));
        const preview = await screen.findByTestId("user-message-preview-u1");
        expect(within(preview).getByTestId("user-message-preview-fallback").textContent).toBe(
            "message.guideEmpty",
        );
    });

    it("超长文本被截断并给出提示", async () => {
        const user = userEvent.setup();
        const entries: UserMessageGuideEntry[] = [
            { id: "u1", messageIndex: 0, text: "x".repeat(900), images: [] },
        ];
        render(<UserMessageGuide entries={entries} onNavigate={vi.fn()} />);

        await user.hover(marker(1));
        const preview = await screen.findByTestId("user-message-preview-u1");
        expect(within(preview).getByTestId("user-message-preview-text").textContent).toBe(
            "x".repeat(800),
        );
        expect(within(preview).getByTestId("user-message-preview-notice").textContent).toBe(
            "message.guideTruncated",
        );
    });
});

describe("UserMessageGuide — 导轨滚动修正", () => {
    it("当前标记已经在可见范围内时导轨不动", () => {
        const { rerender } = render(
            <UserMessageGuide entries={ENTRIES} activeId="u1" onNavigate={vi.fn()} />,
        );
        const rail = screen.getByTestId("user-message-rail");
        stubGeometry(rail, marker(2), {
            scrollTop: 40,
            clientHeight: 100,
            offsetTop: 60,
            offsetHeight: 20,
        });

        rerender(<UserMessageGuide entries={ENTRIES} activeId="u2" onNavigate={vi.fn()} />);
        expect(rail.scrollTop).toBe(40);
    });

    it("当前标记在可见范围外时导轨滚到最近边缘", () => {
        const { rerender } = render(
            <UserMessageGuide entries={ENTRIES} activeId="u1" onNavigate={vi.fn()} />,
        );
        const rail = screen.getByTestId("user-message-rail");
        stubGeometry(rail, marker(3), {
            scrollTop: 40,
            clientHeight: 100,
            offsetTop: 200,
            offsetHeight: 20,
        });

        rerender(<UserMessageGuide entries={ENTRIES} activeId="u3" onNavigate={vi.fn()} />);
        expect(rail.scrollTop).toBe(120);
    });
});
