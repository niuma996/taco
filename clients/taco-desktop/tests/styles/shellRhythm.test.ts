/**
 * Shell rhythm tests — keep the activity rail and message guide aligned with
 * the content card's geometry. These are source contracts because the Tauri
 * webview does not expose a browser automation surface.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const STYLES = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styles");

function stylesheet(file: string): string {
    return readFileSync(resolve(STYLES, file), "utf8");
}

function ruleBody(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{`).exec(css);
    if (!match) return "";
    const open = css.indexOf("{", match.index);
    return css.slice(open + 1, css.indexOf("}", open));
}

describe("desktop shell rhythm", () => {
    it("starts the content card at the activity rail's right edge", () => {
        const body = ruleBody(stylesheet("layout.css"), ".layout");
        assert.match(body, /margin:\s*2px 8px 8px 0;/);
    });

    it("keeps the user-message markers tighter without a visible count", () => {
        const css = stylesheet("chatMessages.css");
        assert.match(ruleBody(css, ".user-message-guide__rail"), /gap:\s*0;/);
        assert.equal(ruleBody(css, ".user-message-guide__count"), "");
    });

    it("grows the guide line from its left edge on hover", () => {
        const css = stylesheet("chatMessages.css");
        const line = ruleBody(css, ".user-message-guide__line");
        assert.match(line, /width:\s*var\(--guide-line-width\)/);
        assert.match(line, /height:\s*var\(--guide-line-height\)/);
        assert.match(line, /border-radius:\s*var\(--radius-pill\)/);
        assert.match(line, /transform-origin:\s*left center/);
        assert.match(
            ruleBody(css, ".user-message-guide__marker:hover .user-message-guide__line"),
            /transform:\s*scaleX\(var\(--guide-line-hover-scale\)\)/,
        );
    });

    it("makes the whole preview card a keyboard-focusable target", () => {
        const css = stylesheet("chatMessages.css");
        const action = ruleBody(css, ".user-message-guide__preview-action");
        assert.match(action, /position:\s*absolute/);
        assert.match(action, /inset:\s*0/);
        assert.match(action, /cursor:\s*pointer/);
    });
});
