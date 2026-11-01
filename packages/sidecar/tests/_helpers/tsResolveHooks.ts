/**
 * Lets Node's native TypeScript support load this repo's ESM sources.
 *
 * `packages/{shared,protocol}` compile with `tsc`, so their source files import
 * each other with `.js` specifiers that only exist in `dist/`. Node's native
 * resolver looks for the literal path and fails; tsx rewrites `.js` to `.ts`.
 * This hook is the test-runner-only equivalent, so the runner can drop tsx
 * without changing how the packages are built.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
            const url = new URL(specifier, context.parentURL);
            const tsUrl = new URL(`${url.pathname.slice(0, -3)}.ts`, url);
            if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(tsUrl))) {
                return nextResolve(tsUrl.href, context);
            }
        }
        return nextResolve(specifier, context);
    },
});
