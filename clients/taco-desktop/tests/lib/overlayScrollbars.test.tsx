import { strict as assert } from "node:assert";
import { afterEach, beforeEach, it, vi } from "vitest";
import { installOverlayScrollbars, isScrollbarPress } from "../../src/lib/overlayScrollbars";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("overlayscrollbars", () => ({ OverlayScrollbars: create }));

let dispose: (() => void) | undefined;

beforeEach(() => {
    create.mockReset();
    create.mockImplementation(() => ({ destroy: vi.fn() }));
});

afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.replaceChildren();
});

function viewport(className: string, overflow = "auto", tag = "div") {
    const node = document.createElement(tag);
    node.className = className;
    node.style.overflowY = overflow;
    document.body.append(node);
    return node;
}

const mutations = () => new Promise((resolve) => setTimeout(resolve, 0));

it("keeps the existing scroll node and only enhances app-owned scroll surfaces", () => {
    const list = viewport("conversation-sidebar-scroll");
    viewport("native-scroll-fixture");
    viewport("user-message-guide__rail");
    viewport("conversation-sidebar-scroll", "auto", "textarea");
    dispose = installOverlayScrollbars(document.body);
    assert.equal(create.mock.calls.length, 1);
    assert.equal(create.mock.calls[0]?.[0].target, list);
    assert.equal(create.mock.calls[0]?.[0].elements.viewport, list);
    assert.equal(create.mock.calls[0]?.[0].scrollbars.slot, list);
    assert.deepEqual(create.mock.calls[0]?.[1].scrollbars, {
        theme: "os-theme-taco",
        visibility: "auto",
        autoHide: "never",
        dragScroll: true,
        clickScroll: "instant",
    });
});

it("installs once on new scroll surfaces, detaches on removal, and cleans up on dispose", async () => {
    dispose = installOverlayScrollbars(document.body);
    const list = viewport("conversation-sidebar-scroll");
    list.append(document.createElement("li"));
    await mutations();
    list.append(document.createElement("li"));
    await mutations();
    assert.equal(create.mock.calls.length, 1);

    const first = create.mock.results[0]?.value;
    list.remove();
    await mutations();
    assert.equal(first.destroy.mock.calls.length, 1);

    viewport("ui-modal-body");
    await mutations();
    assert.equal(create.mock.calls.length, 2);
    dispose();
    assert.equal(create.mock.results[1]?.value.destroy.mock.calls.length, 1);
    viewport("ui-modal-body");
    await mutations();
    assert.equal(create.mock.calls.length, 2);
});

it("enables scrollbars for a reasoning preview, but not its expanded state", async () => {
    const block = viewport("thinking-body thinking-body--full", "visible");
    dispose = installOverlayScrollbars(document.body);
    assert.equal(create.mock.calls.length, 0);
    block.className = "thinking-body thinking-body--preview";
    block.style.overflowY = "auto";
    await mutations();
    assert.equal(create.mock.calls.length, 1);
    block.className = "thinking-body thinking-body--full";
    block.style.overflowY = "visible";
    await mutations();
    assert.equal(create.mock.results[0]?.value.destroy.mock.calls.length, 1);
});

it("reinstalls if framework rendering replaces the generated scrollbar DOM", async () => {
    const wrapper = document.createElement("div");
    wrapper.className = "files-preview-code";
    const code = document.createElement("div");
    code.className = "shiki";
    code.style.overflowX = "auto";
    wrapper.append(code);
    document.body.append(wrapper);
    dispose = installOverlayScrollbars(document.body);
    assert.equal(create.mock.calls.length, 1);

    const bar = document.createElement("div");
    bar.dataset.tacoScrollbar = "";
    code.append(bar);
    await mutations();
    bar.remove();
    await mutations();

    assert.equal(create.mock.results[0]?.value.destroy.mock.calls.length, 1);
    assert.equal(create.mock.calls.length, 2);
});

it("keeps chat scrollbar DOM outside the viewport when React replaces the transcript", async () => {
    const host = viewport("chat-scroll-host");
    const main = document.createElement("main");
    main.style.overflowY = "auto";
    host.append(main);
    dispose = installOverlayScrollbars(document.body);

    assert.equal(create.mock.calls.length, 1);
    assert.equal(create.mock.calls[0]?.[0].target, host);
    assert.equal(create.mock.calls[0]?.[0].elements.viewport, main);
    assert.equal(create.mock.calls[0]?.[0].scrollbars.slot, host);

    main.replaceChildren(document.createElement("article"));
    await mutations();
    assert.equal(create.mock.calls.length, 1);
    assert.equal(create.mock.results[0]?.value.destroy.mock.calls.length, 0);
});

it("recognizes a hosted chat scrollbar without mistaking nested bars for it", () => {
    const host = viewport("chat-scroll-host");
    const main = document.createElement("main");
    const bar = document.createElement("div");
    bar.dataset.tacoScrollbar = "";
    host.append(main, bar);
    const nested = document.createElement("pre");
    const nestedBar = bar.cloneNode() as HTMLElement;
    nested.append(nestedBar);
    main.append(nested);
    const press = (target: HTMLElement) => ({ target, button: 0 }) as unknown as PointerEvent;
    assert.equal(isScrollbarPress(press(bar), main), true);
    assert.equal(isScrollbarPress(press(nestedBar), main), false);
});
