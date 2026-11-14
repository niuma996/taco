import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

/** Bundle independently: portable installs have no node_modules beside the bridge. */
export function buildCodexBridge(libDir) {
    const outfile = join(libDir, "codexCommunicationBridge.mjs");
    buildSync({
        entryPoints: [join(packageRoot, "src/runtime/subagent/codex/codexCommunicationBridge.ts")],
        outfile,
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node22",
        minify: true,
        keepNames: true,
        banner: {
            js: 'import { createRequire as __bridgeRequire } from "node:module"; const require = __bridgeRequire(import.meta.url);',
        },
        logLevel: "warning",
    });
    return outfile;
}
