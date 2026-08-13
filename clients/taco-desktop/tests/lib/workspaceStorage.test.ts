/**
 * workspaceStorage — pure helpers around the workspace list.
 *
 * Only the Tauri-free parts are covered here: `applyExistenceFlags` is the
 * decision core of `pruneMissingCwds`, split out so the filtering rules can be
 * tested without stubbing the IPC layer.
 *
 * Run: cd clients/taco-desktop && pnpm exec tsx --test tests/lib/workspaceStorage.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    applyExistenceFlags,
    isValidWorkspaceCwd,
    lastSegment,
} from "../../src/lib/workspaceStorage.ts";

const DEFAULT = "/Users/me/.taco/workspace";

describe("applyExistenceFlags", () => {
    it("drops entries whose flag is false", () => {
        const cwds = ["/repo/a", "/tmp/gone", "/repo/b"];
        const kept = applyExistenceFlags(cwds, [true, false, true], DEFAULT);
        assert.deepEqual(kept, ["/repo/a", "/repo/b"]);
    });

    it("keeps the default cwd even when reported missing", () => {
        // initDefaultCwd creates it, and it is the fallback once the list is
        // empty — dropping it would leave the fallback outside the list.
        const kept = applyExistenceFlags([DEFAULT, "/tmp/gone"], [false, false], DEFAULT);
        assert.deepEqual(kept, [DEFAULT]);
    });

    it("keeps everything when flags are missing or short", () => {
        // A short array must not silently truncate the list: only an explicit
        // `false` removes an entry.
        assert.deepEqual(applyExistenceFlags(["/repo/a", "/repo/b"], [true], DEFAULT), [
            "/repo/a",
            "/repo/b",
        ]);
        assert.deepEqual(applyExistenceFlags(["/repo/a"], undefined, DEFAULT), ["/repo/a"]);
    });

    it("can empty the list when nothing exists and none is the default", () => {
        // resolveActiveCwd then falls back to the default cwd.
        assert.deepEqual(applyExistenceFlags(["/tmp/x", "/tmp/y"], [false, false], DEFAULT), []);
    });

    it("preserves order of surviving entries", () => {
        const cwds = ["/a", "/b", "/c", "/d"];
        const kept = applyExistenceFlags(cwds, [false, true, false, true], DEFAULT);
        assert.deepEqual(kept, ["/b", "/d"]);
    });
});

describe("isValidWorkspaceCwd", () => {
    it("rejects empty, glob, and shell-metacharacter paths", () => {
        assert.equal(isValidWorkspaceCwd(""), false);
        assert.equal(isValidWorkspaceCwd("/repo/src-tauri/*"), false);
        assert.equal(isValidWorkspaceCwd("/repo/a?b"), false);
        assert.equal(isValidWorkspaceCwd("/repo/[abc]"), false);
        assert.equal(isValidWorkspaceCwd("/repo/$HOME"), false);
        assert.equal(isValidWorkspaceCwd("/repo/`pwd`"), false);
    });

    it("accepts ordinary absolute and relative paths", () => {
        assert.equal(isValidWorkspaceCwd("/Users/me/.taco/workspace"), true);
        assert.equal(isValidWorkspaceCwd("./relative/dir"), true);
    });
});

describe("lastSegment", () => {
    it("returns the trailing directory name", () => {
        assert.equal(lastSegment("/Users/me/.taco/workspace"), "workspace");
        assert.equal(lastSegment("plain"), "plain");
        assert.equal(lastSegment(""), "");
    });
});
