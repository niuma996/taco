import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfig from "./tsconfig.json" with { type: "json" };

/**
 * Derives vite aliases from tsconfig `paths` — avoids duplicating path mappings.
 * Minimal support:
 *   - `"@foo/*": ["../bar/*"]` → regex replace
 *   - `"@foo": ["../bar/baz.ts"]` → exact match
 */
function tsconfigPathsToAliases(
    paths: Record<string, string[]> | undefined,
    baseDir: string,
): Array<{ find: RegExp | string; replacement: string }> {
    if (!paths) return [];
    const aliases: Array<{ find: RegExp | string; replacement: string }> = [];
    for (const [key, candidates] of Object.entries(paths)) {
        const target = candidates[0];
        if (!target) continue;
        const absolute = resolve(baseDir, target);
        if (key.endsWith("/*")) {
            const prefix = key.slice(0, -2);
            aliases.push({
                find: new RegExp(`^${escapeRegExp(prefix)}/(.*)$`),
                replacement: `${absolute.slice(0, -2)}$1`,
            });
        } else {
            aliases.push({ find: key, replacement: absolute });
        }
    }
    return aliases;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default defineConfig({
    plugins: [react()],
    root: ".",
    publicDir: "public",
    resolve: {
        alias: tsconfigPathsToAliases(tsconfig.compilerOptions?.paths, import.meta.dirname),
    },
    build: {
        chunkSizeWarningLimit: 1024,
    },
    server: {
        port: 1420,
        strictPort: true,
        host: "localhost",
    },
});
