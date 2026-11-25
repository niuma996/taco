import { type OverflowBehavior, OverlayScrollbars } from "overlayscrollbars";

const BAR_ATTRIBUTE = "data-taco-scrollbar";
const CHAT_HOST = ".chat-scroll-host";

// App-owned scrollports only. Native form controls and deliberately hidden
// rails keep their existing scrolling affordances.
const VIEWPORTS = [
    CHAT_HOST,
    ".conversation-sidebar-scroll",
    ".subagent-panel-list-scroll",
    ".subagent-panel-detail",
    ".task-panel",
    ".files-tree-root",
    ".files-preview-scroll",
    ".agents-list-body",
    ".catalog-detail",
    ".channels-pane",
    ".checkpoints-groups",
    ".checkpoints-list",
    ".memory-list-body",
    ".plugins-pane",
    ".skills-list-body",
    ".tools-list-body",
    ".tools-detail-schema",
    ".tool-card-raw",
    ".work-groups",
    ".settings-pane-content",
    ".provider-detail-models",
    ".model-menu-popup",
    ".topbar-workspace-menu",
    ".ui-modal-body",
    ".ui-popover-panel__body",
    ".ui-tabs",
    ".thinking-body--preview",
    ".askuser-option-preview",
    ".error-fallback-pre",
    ".md-table-scroll",
    ".md-code-block pre",
    ".md-mermaid",
    ".files-preview-code .shiki",
    ".llm-dump-entries",
    ".llm-dump-lines",
    ".onboarding-body",
    ".onboarding-step > .settings-tab-subsection > .provider-list",
].join(",");

export function scrollbarEventTarget(viewport: HTMLElement): HTMLElement {
    const parent = viewport.parentElement;
    return parent?.matches(CHAT_HOST) ? parent : viewport;
}

export function isScrollbarPress(event: PointerEvent, viewport: HTMLElement): boolean {
    const target = event.target;
    // A nested scroller's thumb is not a grab of the outer scroller.
    return (
        target === viewport ||
        (target instanceof Element &&
            event.button === 0 &&
            target.closest(`[${BAR_ATTRIBUTE}]`)?.parentElement === scrollbarEventTarget(viewport))
    );
}

/** Keep the existing scroll nodes (including their refs, sticky children and events). */
export function installOverlayScrollbars(scope: HTMLElement): () => void {
    const instances = new Map<HTMLElement, OverlayScrollbars>();

    const attach = (node: Element): void => {
        if (
            !(node instanceof HTMLElement) ||
            node instanceof HTMLTextAreaElement ||
            instances.has(node) ||
            !scope.contains(node)
        ) {
            return;
        }
        // Keep transformed scrollbar elements outside the chat's scrollable
        // overflow. Otherwise their previous offsets can keep the old scroll
        // height alive when WebKit replaces a long transcript with a short one.
        const isChat = node.matches(CHAT_HOST);
        const viewport = isChat ? node.querySelector<HTMLElement>(":scope > main") : node;
        if (!viewport) return;
        const { overflowX, overflowY, scrollbarWidth } = getComputedStyle(viewport);
        if (scrollbarWidth === "none") return;
        const axis = (value: string): OverflowBehavior =>
            value === "auto" || value === "scroll" ? "scroll" : "hidden";
        const overflow: { x: OverflowBehavior; y: OverflowBehavior } = isChat
            ? { x: "hidden", y: "scroll" }
            : { x: axis(overflowX), y: axis(overflowY) };
        if (overflow.x === "hidden" && overflow.y === "hidden") return;

        // Keep bars in their own surface (including inside Radix portals).
        const instance = OverlayScrollbars(
            {
                target: node,
                elements: { viewport, padding: false, content: false },
                scrollbars: { slot: node },
            },
            {
                overflow,
                scrollbars: {
                    theme: "os-theme-taco",
                    visibility: "auto",
                    autoHide: "never",
                    dragScroll: true,
                    clickScroll: "instant",
                },
            },
            {
                initialized: (bar) => {
                    const { scrollbarHorizontal, scrollbarVertical } = bar.elements();
                    for (const { scrollbar } of [scrollbarHorizontal, scrollbarVertical]) {
                        scrollbar.setAttribute(BAR_ATTRIBUTE, "");
                        scrollbar.setAttribute("aria-hidden", "true");
                    }
                },
            },
        );
        instances.set(node, instance);
    };

    const attachTree = (root: Element): void => {
        if (root.hasAttribute(BAR_ATTRIBUTE)) return;
        if (root.matches(VIEWPORTS)) attach(root);
        root.querySelectorAll(VIEWPORTS).forEach(attach);
    };

    const detach = (node: HTMLElement, instance: OverlayScrollbars): void => {
        instances.delete(node);
        instance.destroy();
    };

    const observer = new MutationObserver((records) => {
        for (const record of records) {
            const replacedScrollbar =
                record.type === "childList" &&
                Array.from(record.removedNodes).some(
                    (node) => node instanceof Element && node.hasAttribute(BAR_ATTRIBUTE),
                );
            if (replacedScrollbar && record.target instanceof HTMLElement) {
                const node = record.target;
                const instance = instances.get(node);
                if (instance) {
                    detach(node, instance);
                    if (node.matches(VIEWPORTS) && scope.contains(node)) attach(node);
                }
            }
            if (record.type === "attributes" && record.target instanceof HTMLElement) {
                const node = record.target;
                if (node.matches(VIEWPORTS)) attach(node);
                else {
                    const instance = instances.get(node);
                    if (instance) detach(node, instance);
                }
            }
            for (const node of record.addedNodes) {
                if (node instanceof Element && scope.contains(node)) attachTree(node);
            }
        }
        if (records.some(({ removedNodes }) => removedNodes.length > 0)) {
            for (const [node, instance] of instances) {
                if (!scope.contains(node)) detach(node, instance);
            }
        }
    });
    // Body also contains portaled dialogs and menus. Scan only new subtrees
    // after boot, not the whole app whenever a chat message streams in.
    observer.observe(scope, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
    });
    attachTree(scope);
    return () => {
        observer.disconnect();
        for (const [node, instance] of instances) detach(node, instance);
    };
}
