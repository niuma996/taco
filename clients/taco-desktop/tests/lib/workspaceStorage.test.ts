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
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    applyExistenceFlags,
    __migrateFromLocalStorage,
    __resetMigrationStateForTests,
    isValidWorkspaceCwd,
    lastSegment,
    reseedDefaultIfEmpty,
} from "../../src/lib/workspaceStorage.ts";

class MemoryStorage {
    private readonly map = new Map<string, string>();
    getItem(key: string): string | null {
        return this.map.has(key) ? (this.map.get(key) as string) : null;
    }
    setItem(key: string, value: string): void {
        this.map.set(key, String(value));
    }
    removeItem(key: string): void {
        this.map.delete(key);
    }
    clear(): void {
        this.map.clear();
    }
}

const memoryStorage = new MemoryStorage();

beforeEach(() => {
    memoryStorage.clear();
    (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = memoryStorage;
    __resetMigrationStateForTests();
});

afterEach(() => {
    memoryStorage.clear();
});

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

describe("reseedDefaultIfEmpty", () => {
    it("seeds the default cwd when pruning emptied the list", () => {
        // Reproduces the production regression: dev-mode cwds persisted a
        // relative path that resolves to nothing in the NSIS install directory,
        // so the list comes out empty after pruning and the dropdown renders
        // blank until the user opens one. initDefaultCwd has run by this point,
        // so we can fall back to it.
        assert.deepEqual(reseedDefaultIfEmpty([], DEFAULT), [DEFAULT]);
    });

    it("passes through non-empty lists untouched", () => {
        // The default cwd is only a fallback — if any user workspace survives,
        // we keep their ordering. Auto-injecting the default alongside would
        // create a phantom workspace the user never opened.
        const kept = ["/repo/a", "/repo/b"];
        assert.deepEqual(reseedDefaultIfEmpty(kept, DEFAULT), kept);
    });

    it("returns the empty list when no default cwd is available yet", () => {
        // initDefaultCwd failed (e.g. Tauri IPC error). Seeding with "" would
        // create an invalid cwd the resolver would strip anyway; better to
        // surface the failure than mask it.
        assert.deepEqual(reseedDefaultIfEmpty([], ""), []);
    });
});

describe("__migrateFromLocalStorage", () => {
    it("migrates opened + active from LS and clears the legacy keys", () => {
        // The one-shot path that fires on the first call after the workspace
        // storage moved to desktop.json. The legacy keys are removed in the
        // same step so a subsequent read (e.g. a crashed write's recovery
        // path) cannot resurrect them.
        memoryStorage.setItem(
            "taco.workspaces",
            JSON.stringify(["/Users/me/repo-a", "/Users/me/repo-b"]),
        );
        memoryStorage.setItem("taco.activeCwd", "/Users/me/repo-b");

        const migrated = __migrateFromLocalStorage();

        assert.deepEqual(migrated, {
            opened: ["/Users/me/repo-a", "/Users/me/repo-b"],
            active: "/Users/me/repo-b",
        });
        assert.equal(memoryStorage.getItem("taco.workspaces"), null);
        assert.equal(memoryStorage.getItem("taco.activeCwd"), null);
    });

    it("filters out glob / shell-metacharacter cwds during migration", () => {
        // Same validation rules as the live read path. A stale LS value
        // pointing at e.g. `/repo/*` would otherwise sneak into the persisted
        // list and break the workspace selector's path join.
        memoryStorage.setItem(
            "taco.workspaces",
            JSON.stringify(["/good/repo", "/bad/*", "/bad/$HOME"]),
        );
        memoryStorage.setItem("taco.activeCwd", "/bad/$HOME");

        const migrated = __migrateFromLocalStorage();

        // opened keeps only the valid cwd; active falls back to "" because the
        // stored value was invalid (the resolveActiveCwd resolver downstream
        // then re-derives it from opened[0] or the default cwd).
        assert.deepEqual(migrated, { opened: ["/good/repo"], active: "" });
    });

    it("returns null when LS has neither legacy key", () => {
        // Fresh install after the cutover — no legacy data, nothing to do.
        assert.equal(__migrateFromLocalStorage(), null);
    });

    it("is idempotent across calls within a process", () => {
        // The guard prevents repeat runs. Without it, a hot-reload or a
        // second loadWorkspaces would re-copy (and re-clear) the same LS
        // keys, which is fine functionally but noisy in logs and wastes
        // IPC roundtrips.
        memoryStorage.setItem("taco.workspaces", JSON.stringify(["/a", "/b"]));

        const first = __migrateFromLocalStorage();
        // Re-seed LS after the first call wiped it, to confirm the second
        // call short-circuits rather than re-migrating.
        memoryStorage.setItem("taco.workspaces", JSON.stringify(["/x"]));
        const second = __migrateFromLocalStorage();

        assert.deepEqual(first, { opened: ["/a", "/b"], active: "" });
        assert.equal(second, null);
        // The /x we re-seeded stays in LS — the guard won, so the legacy
        // path was not taken again. Real production behavior: this branch
        // is only hit in unit tests; in production loadWorkspaces is the
        // sole caller and the guard prevents repeat reads.
        assert.equal(memoryStorage.getItem("taco.workspaces"), JSON.stringify(["/x"]));
    });

    it("survives corrupt JSON in the legacy opened key", () => {
        // A malformed localStorage value would otherwise throw and abort the
        // whole init path. We swallow the parse error and treat it as "no
        // migration source" so the read path falls back to the empty default.
        memoryStorage.setItem("taco.workspaces", "{not valid json");
        memoryStorage.setItem("taco.activeCwd", "/Users/me/repo");

        const migrated = __migrateFromLocalStorage();

        // opened is unreadable so we get no opened migration, but the active
        // cwd is a plain string and is honored.
        assert.deepEqual(migrated, { opened: [], active: "/Users/me/repo" });
    });
});
