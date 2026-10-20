/**
 * Workspace associations — the command scope they widen.
 *
 * An association lets a shell command `cd` into a directory beyond the
 * workspace's own root. It does NOT make the command itself auto-allowed:
 * the command policy still decides. These pin both halves, because a
 * regression in either direction is a security change:
 *  - the `cd` is authorized (the point of the feature);
 *  - the command that follows is still evaluated against the rules.
 *
 * The evaluation is driven through `evaluateCommand` with the same context
 * the PermissionBroker builds — the broker's contribution is assembling
 * `allowedRoots` from the workspace's root plus its associations, which is
 * what the WorkspaceRuntime wiring does.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { evaluateCommand } from "../../src/permissions/commandPolicy.ts";

const manual = { mode: "ask" as const, allow: [], deny: [] };

/** The context the workspace builds: its own root plus the associations. */
function context(root: string, associated: readonly string[] = []) {
    return { cwd: root, allowedRoots: [root, ...associated] };
}

describe("workspace associations widen the command scope", () => {
    it("authorizes a cd into an associated directory", () => {
        const root = mkdtempSync(join(tmpdir(), "taco-assoc-root-"));
        const associated = mkdtempSync(join(tmpdir(), "taco-assoc-dir-"));
        try {
            // The cd resolves inside an authorized root → the directory
            // change is allowed, not asked.
            const result = evaluateCommand(
                `cd "${associated}" && git diff`,
                manual,
                context(root, [associated]),
            );
            assert.equal(result.behavior, "allow");
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(associated, { recursive: true, force: true });
        }
    });

    it("still asks for a cd outside the workspace and its associations", () => {
        const root = mkdtempSync(join(tmpdir(), "taco-assoc-root-"));
        const associated = mkdtempSync(join(tmpdir(), "taco-assoc-dir-"));
        const outside = mkdtempSync(join(tmpdir(), "taco-assoc-out-"));
        try {
            const result = evaluateCommand(
                `cd "${outside}" && git diff`,
                manual,
                context(root, [associated]),
            );
            assert.equal(result.behavior, "ask");
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(associated, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });

    it("still applies the command rules after an authorized cd", () => {
        const root = mkdtempSync(join(tmpdir(), "taco-assoc-root-"));
        const associated = mkdtempSync(join(tmpdir(), "taco-assoc-dir-"));
        try {
            // The cd is authorized, but `rm -rf` is not on the allow list —
            // the association must not turn it into an auto-allow.
            const result = evaluateCommand(
                `cd "${associated}" && rm -rf build`,
                manual,
                context(root, [associated]),
            );
            assert.equal(result.behavior, "ask");
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(associated, { recursive: true, force: true });
        }
    });

    it("does not let an association widen a command the rules allow elsewhere", () => {
        const root = mkdtempSync(join(tmpdir(), "taco-assoc-root-"));
        const associated = mkdtempSync(join(tmpdir(), "taco-assoc-dir-"));
        try {
            // A deny rule applies regardless of where the command runs.
            const result = evaluateCommand(
                `cd "${associated}" && rm -rf build`,
                { ...manual, allow: ["*"], deny: ["rm -rf build"] },
                context(root, [associated]),
            );
            assert.equal(result.behavior, "ask");
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(associated, { recursive: true, force: true });
        }
    });

    it("keeps the workspace root authorized when there are no associations", () => {
        const root = mkdtempSync(join(tmpdir(), "taco-assoc-root-"));
        const sub = join(root, "sub");
        mkdirSync(sub, { recursive: true });
        try {
            const result = evaluateCommand(`cd "${sub}" && git diff`, manual, context(root));
            assert.equal(result.behavior, "allow");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a cd that escapes an associated directory", () => {
        const root = mkdtempSync(join(tmpdir(), "taco-assoc-root-"));
        const associated = mkdtempSync(join(tmpdir(), "taco-assoc-dir-"));
        const outside = mkdtempSync(join(tmpdir(), "taco-assoc-out-"));
        try {
            // The associated root is authorized, but a cd out of it is not.
            const result = evaluateCommand(
                `cd "${associated}" && cd "${outside}" && git diff`,
                manual,
                context(root, [associated]),
            );
            assert.equal(result.behavior, "ask");
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(associated, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });
});
