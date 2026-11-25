/**
 * themeLines tests — the global rule for separator lines.
 *
 * Both themes draw their separators *below* the surface they sit on: the
 * dark theme on the near-black shell, the light theme on warm paper. A theme
 * that flips one family of lines to a brighter shade breaks that rule, and
 * the breakage is invisible in unit tests — it only shows up as a bright
 * seam in the running app. These tests read theme.css and hold the rule.
 *
 * Run:
 *   tsx --test tests/styles/themeLines.test.ts
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styles/theme.css"),
    "utf8",
);

const DARK = CSS.slice(0, CSS.indexOf(':root[data-theme="light"]'));
const LIGHT = CSS.slice(CSS.indexOf(':root[data-theme="light"]'));

/** Relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
    const value = hex.replace("#", "");
    const channels = [0, 2, 4].map((offset) => {
        const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

/** The colour a line paints, composited over the surface it sits on. */
function composited(line: string, surfaceHex: string): string {
    const rgba = line.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
    if (rgba) {
        const [, r, g, b, a] = rgba;
        const alpha = Number(a);
        const base = [0, 2, 4].map((offset) =>
            Number.parseInt(surfaceHex.replace("#", "").slice(offset, offset + 2), 16),
        );
        const mix = (channel: number, index: number) =>
            Math.round(channel * alpha + base[index] * (1 - alpha));
        return `#${[mix(Number(r), 0), mix(Number(g), 1), mix(Number(b), 2)]
            .map((channel) => channel.toString(16).padStart(2, "0"))
            .join("")}`;
    }
    return line.trim();
}

function token(scope: string, name: string): string {
    const raw = scope.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim() ?? "";
    // Follow the var() chain to the value it stands for.
    return raw.replace(/var\(--([a-z0-9-]+)\)/, (_match, referenced: string) =>
        token(scope, referenced),
    );
}

/** The line families that separate surfaces. */
const LINE_TOKENS = ["border", "divider-panel", "divider-section", "divider-inline"];

describe("theme separator lines", () => {
    it("draws the dark theme's lines below the surface they sit on", () => {
        const surface = token(DARK, "chat-panel-bg");
        for (const name of LINE_TOKENS) {
            const line = composited(token(DARK, name), surface);
            assert.ok(
                luminance(line) < luminance(surface),
                `--${name} (${line}) should be darker than the chat panel (${surface})`,
            );
        }
    });

    it("draws the light theme's lines below the surface they sit on", () => {
        const surface = token(LIGHT, "chat-panel-bg");
        for (const name of LINE_TOKENS) {
            const line = composited(token(LIGHT, name), surface);
            assert.ok(
                luminance(line) < luminance(surface),
                `--${name} (${line}) should be darker than the chat panel (${surface})`,
            );
        }
    });

    it("uses the shell surface for light chat seams and keeps the dark panel divider", () => {
        assert.equal(token(LIGHT, "divider-chat-panel"), token(LIGHT, "shell-bg"));
        assert.equal(token(DARK, "divider-chat-panel"), token(DARK, "divider-panel"));
    });

    it("keeps the raised edges lighter than the surface they sit on", () => {
        const surface = token(DARK, "chat-panel-bg");
        const raised = composited(token(DARK, "border-raised"), surface);
        // The composer card and the rail dividers are objects on a surface,
        // not seams between two — they keep the old light line.
        assert.ok(
            luminance(raised) > luminance(surface),
            `--border-raised (${raised}) should be lighter than the chat panel (${surface})`,
        );
    });

    it("keeps the rail dividers on the raised edge", () => {
        const css = readFileSync(
            resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styles/sidebar.css"),
            "utf8",
        );
        const ruleBody = (css: string, selector: string): string => {
            // Match a selector that starts its own line — ".ui-select-trigger"
            // also appears inside compound selectors earlier in the file.
            const name = selector.endsWith(" {") ? selector.slice(0, -2) : selector;
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{`).exec(css);
            if (!match) return "";
            const open = css.indexOf("{", match.index);
            return css.slice(open + 1, css.indexOf("}", open));
        };
        // The rail's short dividers cut a column out of the band instead of
        // splitting two surfaces, so they keep the light line.
        for (const selector of [
            ".ui-divider.activity-rail-divider",
            ".ui-divider.activity-rail-separator",
        ]) {
            assert.match(
                ruleBody(css, selector),
                /background:\s*var\(--border-raised\)/,
                `${selector} should keep the light raised edge`,
            );
        }
    });

    it("gives dark theme cards a surface that reads above the panel", () => {
        const surface = token(DARK, "chat-panel-bg");
        // The border is a shadow line now, so the card's own surface is what
        // separates it from the panel behind it. A 3% wash was not enough.
        for (const name of ["surface-tint", "bg-card"]) {
            const card = composited(token(DARK, name), surface);
            const step = luminance(card) - luminance(surface);
            assert.ok(
                step >= 0.004,
                `--${name} (${card}) should sit a visible step above the panel (${surface})`,
            );
        }
    });

    it("gives the composer a dark line and lets its surface do the separating", () => {
        const styles = (file: string): string =>
            readFileSync(
                resolve(dirname(fileURLToPath(import.meta.url)), `../../src/styles/${file}`),
                "utf8",
            );
        const ruleBody = (css: string, selector: string): string => {
            // Match a selector that starts its own line — ".ui-select-trigger"
            // also appears inside compound selectors earlier in the file.
            const name = selector.endsWith(" {") ? selector.slice(0, -2) : selector;
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{`).exec(css);
            if (!match) return "";
            const open = css.indexOf("{", match.index);
            return css.slice(open + 1, css.indexOf("}", open));
        };
        const css = styles("chatInput.css");

        // The card itself takes the shadow line again — the typing band inside
        // is what tells the input area apart from the chat panel.
        assert.match(ruleBody(css, ".input-card"), /border:\s*1px solid var\(--border\)/);
        assert.match(ruleBody(css, "footer.input textarea"), /background:\s*var\(--bg-card\)/);
    });

    it("sinks the segmented-control track and raises its active segment", () => {
        const panel = token(DARK, "chat-panel-bg");
        const track = composited(token(DARK, "segment-track"), panel);
        const active = composited(token(DARK, "segment-active-bg"), track);
        // A well is below the surface it sits in; the active pill is above it.
        assert.ok(
            luminance(track) < luminance(panel),
            `--segment-track (${track}) should be below the panel (${panel})`,
        );
        assert.ok(
            luminance(active) > luminance(track),
            `--segment-active-bg (${active}) should be above the track (${track})`,
        );
    });

    it("gives the section headings room above them", () => {
        const css = readFileSync(
            resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styles/channelsPane.css"),
            "utf8",
        );
        const at = css.indexOf(".channels-sections {");
        const open = css.indexOf("{", at);
        const rule = css.slice(open + 1, css.indexOf("}", open));
        // The first heading follows a hint box outside the group; without the
        // step it crowds that box while the headings inside get a full gap.
        assert.match(rule, /margin-top:\s*var\(--space-2\)/);
    });

    it("puts the objects that sit on a panel on the card surface", () => {
        const styles = (file: string): string =>
            readFileSync(
                resolve(dirname(fileURLToPath(import.meta.url)), `../../src/styles/${file}`),
                "utf8",
            );
        const ruleBody = (css: string, selector: string): string => {
            // Match a selector that starts its own line — ".ui-select-trigger"
            // also appears inside compound selectors earlier in the file.
            const name = selector.endsWith(" {") ? selector.slice(0, -2) : selector;
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{`).exec(css);
            if (!match) return "";
            const open = css.indexOf("{", match.index);
            return css.slice(open + 1, css.indexOf("}", open));
        };
        const cases: [string, string][] = [
            ["paneShared.css", ".pane-card"],
            ["checkpointsPane.css", ".checkpoint-item"],
            ["workPane.css", ".work-item"],
            ["skillsPane.css", ".skills-list-item"],
            ["toolsPane.css", ".tools-list-item"],
            ["ui.css", ".ui-select-trigger {"],
        ];
        for (const [file, selector] of cases) {
            assert.match(
                ruleBody(styles(file), selector),
                /background:\s*var\(--bg-card\)/,
                `${selector} should sit on the card surface`,
            );
        }
    });

    it("uses the previous light-theme orange consistently in both themes", () => {
        assert.equal(token(DARK, "brand-orange"), "#d97a44");
        assert.equal(token(LIGHT, "brand-orange"), "#d97a44");
        assert.equal(token(DARK, "brand-orange-hover"), "#cc6f39");
        assert.equal(token(LIGHT, "brand-orange-hover"), "#cc6f39");
    });

    it("keeps the brand orange in the same orange hue family", () => {
        const hsl = (hex: string): { h: number; s: number; l: number } => {
            const value = hex.replace("#", "");
            const [r, g, b] = [0, 2, 4].map(
                (offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255,
            );
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const delta = max - min;
            const hue =
                delta === 0
                    ? 0
                    : max === r
                      ? 60 * (((g - b) / delta) % 6)
                      : max === g
                        ? 60 * ((b - r) / delta + 2)
                        : 60 * ((r - g) / delta + 4);
            return {
                h: hue < 0 ? hue + 360 : hue,
                s: max === 0 ? 0 : delta / max,
                l: (max + min) / 2,
            };
        };
        for (const scope of [DARK, LIGHT]) {
            const orange = token(scope, "brand-orange");
            const { h, s, l } = hsl(orange);
            // The shared value is the previous light-theme macaron orange:
            // soft enough to avoid the original bright orange, while still
            // reading clearly as the brand accent.
            assert.ok(h >= 15 && h <= 35, `${orange} should stay in the orange hue family`);
            assert.ok(s <= 0.72, `${orange} should be a softer (macaron) orange`);
            assert.ok(l >= 0.55, `${orange} should be a lighter (macaron) orange`);
        }
    });

    it("keeps semantic surface tiers distinct in both themes", () => {
        for (const scope of [DARK, LIGHT]) {
            const card = token(scope, "bg-card");
            const secondary = token(scope, "bg-secondary");
            const floating = token(scope, "bg-float");
            const elevated = token(scope, "bg-elevated");
            assert.notEqual(card, secondary, "card and secondary surfaces need separate roles");
            assert.notEqual(card, floating, "card and floating surfaces need separate roles");
            assert.equal(
                elevated,
                floating,
                "legacy elevated surface should alias floating surface",
            );
        }
    });

    it("keeps ordinary content shadows soft and free of a ring", () => {
        for (const scope of [DARK, LIGHT]) {
            const shadow = token(scope, "card-shadow");
            assert.doesNotMatch(
                shadow,
                /0\s+0\s+0\s+1px/,
                `card shadow should not draw a hard ring: ${shadow}`,
            );
            assert.doesNotMatch(
                shadow,
                /rgba\([^)]*,\s*0\.5[0-9]*\)/,
                `card shadow should stay soft: ${shadow}`,
            );
        }
    });

    it("keeps the dark theme's content card free of a bright hairline", () => {
        const shadow = token(DARK, "card-shadow");
        assert.ok(
            !/rgba\(\s*255\s*,\s*255\s*,\s*255/.test(shadow),
            `the dark card shadow must not ring the card in white: ${shadow}`,
        );
    });

    it("keeps the light theme's content card free of a bright hairline", () => {
        const shadow = token(LIGHT, "card-shadow");
        assert.ok(
            !/rgba\(\s*255\s*,\s*255\s*,\s*255/.test(shadow),
            `the light card shadow must not ring the card in white: ${shadow}`,
        );
    });
});
