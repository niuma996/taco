import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { it } from "node:test";

const read = (path: string) =>
    readFileSync(new URL(`../../src/styles/${path}`, import.meta.url), "utf8");

it("centers workspace and channel conversation rows independently of scrollbar visibility", () => {
    const css = read("conversationSidebar.css");
    const scroller = /\.conversation-sidebar-scroll\s*\{([^}]+)\}/.exec(css)?.[1];
    const rows =
        /ul\.conversation-channel-list \.session-item,\s*\.conversation-group-body > \.session-list-panel \.session-item\s*\{([^}]+)\}/.exec(
            css,
        )?.[1];
    assert.match(scroller ?? "", /padding-inline:\s*var\(--space-1\);/);
    assert.match(rows ?? "", /margin-inline:\s*var\(--space-1\);/);
});

it("defines a narrow, neutral scrollbar whose native gutter is removed", () => {
    const theme = read("theme.css");
    const scrollbars = read("scrollbars.css");
    assert.match(theme, /--scrollbar-size:\s*var\(--space-1-5\);/);
    assert.match(theme, /--scrollbar-thumb-rest:[\s\S]*?var\(--fg-dim\) 25%/);
    assert.match(theme, /--scrollbar-thumb-hover:[\s\S]*?var\(--fg-dim\) 48%/);
    assert.match(theme, /--scrollbar-thumb-active:[\s\S]*?var\(--fg-dim\) 68%/);
    assert.match(
        scrollbars,
        /\[data-overlayscrollbars\],\s*\[data-overlayscrollbars-viewport\]\s*\{[^}]*scrollbar-width:\s*none !important;/,
    );
    assert.match(
        scrollbars,
        /\[data-overlayscrollbars\]::-webkit-scrollbar[\s\S]*?display:\s*none !important;/,
    );
    assert.match(scrollbars, /--os-handle-bg:\s*var\(--scrollbar-thumb-rest\);/);
    assert.match(scrollbars, /z-index:\s*2;/);
});

it("reveals scrollbars only while their scroll container is hovered", () => {
    const scrollbars = read("scrollbars.css");
    assert.match(
        scrollbars,
        /:where\(\*:not\(:hover\)\)\s*\{\s*scrollbar-color:\s*transparent\s+transparent;/,
    );
    assert.match(
        scrollbars,
        /:where\(\*:hover\)\s*\{\s*scrollbar-color:\s*var\(--scrollbar-thumb-rest\)\s+transparent;/,
    );
    assert.match(
        scrollbars,
        /:not\(:hover\)::-webkit-scrollbar-thumb\s*\{\s*background:\s*transparent;/,
    );
    assert.match(scrollbars, /\.os-scrollbar\.os-theme-taco\s*\{[\s\S]*?opacity:\s*0;/);
    assert.match(scrollbars, /--os-handle-bg:\s*var\(--scrollbar-thumb-rest\);/);
    assert.match(
        scrollbars,
        /\[data-overlayscrollbars\]:hover\s*>\s*\.os-scrollbar\.os-theme-taco\.os-scrollbar-visible[\s\S]*?opacity:\s*1;/,
    );
    assert.match(
        scrollbars,
        /\.os-scrollbar-handle-interactive\s+\.os-scrollbar-handle\s*\{\s*pointer-events:\s*auto;/,
    );
});
