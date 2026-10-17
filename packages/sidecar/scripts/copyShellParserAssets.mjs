import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Keep WASM grammars next to both npm and portable runtime ESM bundles. */
export function copyShellParserAssets(libDir) {
    const destination = join(libDir, "grammars");
    mkdirSync(destination, { recursive: true });
    cpSync(fileURLToPath(new URL("../src/permissions/grammars/", import.meta.url)), destination, { recursive: true });
    const require = createRequire(import.meta.url);
    const runtime = require.resolve("web-tree-sitter/tree-sitter.wasm");
    copyFileSync(runtime, join(destination, "tree-sitter.wasm"));
    copyFileSync(join(runtime, "..", "LICENSE"), join(destination, "LICENSE.web-tree-sitter"));
}
