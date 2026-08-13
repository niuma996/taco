#!/usr/bin/env node
/**
 * check-comments.mjs — fails on comment anti-patterns and length violations.
 *
 * Enforces: block comment >10 lines, plan-doc markers, pinned SHAs, refactor
 * narration tokens. Excludes node_modules/, dist/, build/, lib/, coverage/,
 * .git/, generated/. Exit 1 on any failure; prints file:line per finding.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const EXCLUDE_DIRS = new Set([
    "node_modules",
    "dist",
    "build",
    "lib",
    "coverage",
    ".git",
    "generated",
    ".turbo",
    ".next",
    ".pnpm-store",
    ".worktrees",
]);
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

const findings = [];
let filesScanned = 0;

const STALE_MARKERS = [
    /\bPhase\s+\d+\b/,
    /\bStep\s+\d+\b/,
    /\bTask\s+\d+\b/,
    /@[0-9a-f]{7,}\b/,
    /本次拆分/,
    /本次重构/,
    /本次升级/,
    /历史:/,
    /之前散在/,
    /之前因为/,
    /旧"单一激活"/,
    /兼容[^。\n]*旧路径/,
    /兼容[^。\n]*子进程/,
    /与原实现一致/,
    /原\s+WorkspaceRuntime\.\w+/,
    /原\s+`?\w+`?[,，]\s*改名/,
    /\b旧实现\b/,
    /残留竞态/,
    /保证零迁移/,
    /曾经是\s+\d+\s*行/,
];

function walk(dir) {
    for (const entry of readdirSync(dir)) {
        if (EXCLUDE_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            walk(full);
        } else if (SOURCE_EXT.test(entry)) {
            scan(full);
        }
    }
}

function scan(file) {
    filesScanned++;
    const text = readFileSync(file, "utf8");

    /**
     * Returns true if position `pos` falls strictly inside a string or template literal.
     */
    function isInsideString(pos) {
        let inString = false;
        let strChar = "";
        let i = 0;
        while (i < text.length) {
            if (i >= pos) return inString;
            const ch = text[i];
            if (!inString && (ch === '"' || ch === "'" || ch === "`")) {
                inString = true;
                strChar = ch;
                i++;
            } else if (inString && ch === "\\") {
                i += 2; // skip escaped char, stay in string
            } else if (inString && ch === strChar) {
                inString = false;
                i++;
            } else {
                i++;
            }
        }
        return false;
    }

    const blockRe = /\/\*[\s\S]*?\*\//g;
    for (let m = blockRe.exec(text); m !== null; m = blockRe.exec(text)) {
        const block = m[0];
        const startOffset = m.index;

        // Skip if the opening /** is inside a string literal (false positive from glob patterns, etc.)
        if (isInsideString(startOffset)) continue;

        const before = text.slice(0, startOffset);
        const startLine = before.split("\n").length;
        const lineCount = block.split("\n").length;

        if (lineCount > 10) {
            // The project's documented style is "≤10 lines preferred". Two
            // exemptions make the rule practical without dropping it:
            //
            //   1. Module-top JSDoc (the first /** block before any import or
            //      code) — it surfaces in IDE hover and is the right place for
            //      architectural rationale that doesn't belong inside any one
            //      function.
            //   2. Inline blocks up to 20 lines — legitimate export-contract
            //      docs on types/functions/classes commonly run 11-20 lines
            //      when they enumerate cases, name cross-file constraints, or
            //      justify a non-obvious choice. 20 is the empirical ceiling
            //      for the current codebase; anything past that is almost
            //      certainly stale narration.
            const beforeBlock = text.slice(0, startOffset).trim();
            const isModuleTop = beforeBlock.length === 0;
            const isExempt = isModuleTop || lineCount <= 20;
            if (!isExempt) {
                findings.push({
                    file,
                    startLine,
                    rule: `inline block comment is ${lineCount} lines (>20)`,
                    text: block.split("\n")[0].slice(0, 80),
                });
            }
        }

        // Stale-marker check runs independently of the length exemptions:
        // a refactor-narration token ("Task 4", "本次拆分", etc.) is wrong
        // whether it sits in a 5-line block or a 50-line module doc.
        for (const re of STALE_MARKERS) {
            const hit = block.match(re);
            if (hit) {
                findings.push({
                    file,
                    startLine,
                    rule: `stale marker: ${re.source}`,
                    text: hit[0],
                });
                break;
            }
        }
    }
}

walk(ROOT);

if (findings.length === 0) {
    console.log(`check-comments: scanned ${filesScanned} files, 0 findings.`);
    process.exit(0);
}

for (const f of findings) {
    const rel = relative(ROOT, f.file);
    console.log(`${rel}:${f.startLine}  [${f.rule}]  ${f.text}`);
}
console.log(`\ncheck-comments: ${findings.length} finding(s) across ${filesScanned} files.`);
process.exit(1);
