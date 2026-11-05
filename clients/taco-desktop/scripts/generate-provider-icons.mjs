/**
 * Regenerate `src/components/settings/providerIconPaths.ts` from the vendored
 * SVG files in `src/assets/provider-icons/`.
 *
 * ProviderIcon builds CSS mask data URIs from these paths so brand marks
 * follow the theme without injecting SVG markup.
 *
 * Run: node scripts/generate-provider-icons.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, "..", "src", "assets", "provider-icons");
const outFile = join(here, "..", "src", "components", "settings", "providerIconPaths.ts");

/** Files to extract, in the order they appear in the generated module. */
const FILES = [
    "anthropic.svg",
    "deepseek.svg",
    "gemini.svg",
    "minimax.svg",
    "moonshot.svg",
    "openai.svg",
    "openrouter.svg",
    "xai.svg",
    "zai.svg",
];

const entries = FILES.map((file) => {
    const svg = readFileSync(join(iconsDir, file), "utf8");
    const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
    if (!viewBox) throw new Error(`${file}: no viewBox`);
    // The fill rule decides which subpaths count as inside the shape; every
    // vendored mark uses evenodd, and dropping it changes the outline.
    const fillRule = /fill-rule="([^"]+)"/.exec(svg)?.[1] ?? "nonzero";
    const paths = [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
    if (paths.length === 0) throw new Error(`${file}: no path data`);
    const key = file.replace(/\.svg$/, "");
    return { key, viewBox, fillRule, paths };
});

const body = entries
    .map(
        (e) =>
            `    ${e.key}: {\n        viewBox: ${JSON.stringify(e.viewBox)},\n` +
            `        fillRule: ${JSON.stringify(e.fillRule)},\n` +
            `        paths: [\n${e.paths.map((d) => `            ${JSON.stringify(d)},`).join("\n")}\n        ],\n    },`,
    )
    .join("\n");

writeFileSync(
    outFile,
    `/**
 * Path data for the built-in provider marks.
 *
 * GENERATED FILE — do not edit. Run \`node scripts/generate-provider-icons.mjs\`
 * after changing the SVGs in \`src/assets/provider-icons/\`.
 *
 * ProviderIcon turns these paths into CSS mask data URIs and paints them
 * with the theme foreground colour. See \`ProviderIcon.tsx\`.
 *
 * Source: @lobehub/icons-static-svg (MIT) — see
 * \`src/assets/provider-icons/ATTRIBUTION.md\`.
 */

export interface ProviderIconShape {
    /** The SVG viewBox the paths are drawn in. */
    viewBox: string;
    /** Fill rule for the paths — decides which subpaths count as inside. */
    fillRule: string;
    /** Path data, one entry per <path> element. */
    paths: readonly string[];
}

export const PROVIDER_ICON_SHAPES: Readonly<Record<string, ProviderIconShape>> = {
${body}
};
`,
    "utf8",
);

console.log(`wrote ${outFile} (${entries.length} icons)`);
