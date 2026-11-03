/**
 * rightPanelWidth pure-function tests — Node 22 built-in `node:test` runner via tsx.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test:right-panel-width
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    chatAreaWidth,
    clampPanelRatio,
    minPanelRatio,
    panelWidthPx,
    RIGHT_PANEL_DEFAULT_RATIO,
    RIGHT_PANEL_MAX_RATIO,
    sidebarWidthPx,
} from "../../src/lib/rightPanelWidth";

function close(actual: number, expected: number, tolerance = 1e-9): void {
    assert.ok(
        Math.abs(actual - expected) < tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`,
    );
}

describe("sidebarWidthPx", () => {
    it("is zero when the sidebar is collapsed", () => {
        assert.equal(sidebarWidthPx(1440, true), 0);
    });

    it("mirrors the CSS clamp", () => {
        assert.equal(sidebarWidthPx(1000, false), 220); // 20vw = 200 → floor 220
        assert.equal(sidebarWidthPx(1440, false), 288); // 20vw = 288 → in range
        assert.equal(sidebarWidthPx(2560, false), 340); // 20vw = 512 → ceiling 340
    });

    it("falls back to the reference viewport for a nonsensical size", () => {
        assert.equal(sidebarWidthPx(Number.NaN, false), 288);
    });
});

describe("chatAreaWidth", () => {
    it("is the viewport minus the rail and the sidebar", () => {
        assert.equal(chatAreaWidth(1440, false), 1440 - 56 - 288);
    });

    it("grows when the sidebar is collapsed", () => {
        assert.equal(chatAreaWidth(1440, true), 1440 - 56);
    });

    it("falls back to the reference viewport for a nonsensical size", () => {
        assert.equal(chatAreaWidth(Number.NaN, false), 1440 - 56 - 288);
    });

    it("never goes negative", () => {
        assert.ok(chatAreaWidth(100, false) >= 0);
    });
});

describe("minPanelRatio", () => {
    it("is the default share when that is the wider of the two floors", () => {
        // 250/1096 = 23% → the default 30% wins.
        assert.equal(minPanelRatio(1096), RIGHT_PANEL_DEFAULT_RATIO);
    });

    it("keeps the 250px floor when that is the wider of the two", () => {
        // 250/600 = 42% → the px floor wins.
        close(minPanelRatio(600), 250 / 600);
    });

    it("gives way to the 50% ceiling on a narrow layout", () => {
        assert.equal(minPanelRatio(324), RIGHT_PANEL_MAX_RATIO);
    });

    it("is the ceiling when the chat area is unusable", () => {
        assert.equal(minPanelRatio(0), RIGHT_PANEL_MAX_RATIO);
    });
});

describe("clampPanelRatio", () => {
    it("falls back to the default for a malformed request", () => {
        assert.equal(clampPanelRatio(undefined, 1096), RIGHT_PANEL_DEFAULT_RATIO);
        assert.equal(clampPanelRatio("0.3", 1096), RIGHT_PANEL_DEFAULT_RATIO);
        assert.equal(clampPanelRatio(Number.NaN, 1096), RIGHT_PANEL_DEFAULT_RATIO);
        assert.equal(clampPanelRatio(Number.POSITIVE_INFINITY, 1096), RIGHT_PANEL_DEFAULT_RATIO);
    });

    it("keeps a request inside the bounds", () => {
        assert.equal(clampPanelRatio(0.3, 1096), 0.3);
        assert.equal(clampPanelRatio(0.9, 1096), RIGHT_PANEL_MAX_RATIO);
    });

    it("raises a request that would render below the default share", () => {
        assert.equal(clampPanelRatio(0.05, 1096), RIGHT_PANEL_DEFAULT_RATIO);
    });

    it("raises a request that would render below the 250px floor", () => {
        close(clampPanelRatio(0.05, 600), 250 / 600);
    });

    it("lets the ceiling win over the floor on a narrow layout", () => {
        assert.equal(clampPanelRatio(0.9, 324), RIGHT_PANEL_MAX_RATIO);
    });
});

describe("panelWidthPx", () => {
    it("renders the share against the chat area", () => {
        assert.equal(panelWidthPx(0.3, 1096), 329);
    });

    it("is zero when the chat area is unusable", () => {
        assert.equal(panelWidthPx(0.3, 0), 0);
    });
});
