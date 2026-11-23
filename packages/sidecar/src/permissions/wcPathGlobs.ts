import { isSafeReadOnlyPathGlob } from "./pathGlobs.ts";
import type { ParsedShellNode } from "./shellParser.ts";

const WC_FLAGS = /^-[cmwlL]+$/;
const WC_LONG_FLAGS = new Set(["--bytes", "--chars", "--lines", "--max-line-length", "--words"]);

/** Accept only bounded `wc` statistics over literal paths or ordinary globs. */
export function isReadOnlyWcPathGlob(node: ParsedShellNode): boolean {
    if (node.argv[0] !== "wc" || node.argumentKinds[0] !== "literal" || node.redirects)
        return false;
    if (!node.argumentKinds.includes("glob")) return false;
    let endOfOptions = false;
    return node.argv.slice(1).every((arg, index) => {
        const kind = node.argumentKinds[index + 1];
        if (kind === "glob") return isSafeReadOnlyPathGlob(arg, false);
        if (kind !== "literal") return false;
        if (arg === "-") return false;
        if (endOfOptions) return true;
        if (arg === "--") {
            endOfOptions = true;
            return true;
        }
        return !arg.startsWith("-") || WC_FLAGS.test(arg) || WC_LONG_FLAGS.has(arg);
    });
}
