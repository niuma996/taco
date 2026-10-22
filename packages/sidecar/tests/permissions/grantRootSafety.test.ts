/**
 * The roots a workspace may never be granted.
 *
 * The IM policy's custom execution directory is a grant of the same kind as
 * an associated directory — it becomes the workspace's ROOT, and the root is
 * what the read/write fence measures against — so it is held to the same
 * rules. These tests pin both halves: the write path refuses such a
 * directory, and the runtime refuses one that reached the file another way.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { after, before, describe, it } from "node:test";
import { ImWorkspacePolicyStore } from "../../src/channels/imWorkspacePolicyStore.ts";
import { checkGrantRootSafety } from "../../src/permissions/grantRootSafety.ts";
import { resolveImExecutionCwd } from "../../src/server/imExecutionCwd.ts";

describe("grantRootSafety", () => {
    // The Taco-home rule is checked against the REAL $TACO_HOME, so the test
    // points it at a temp dir rather than the developer's.
    let home: string;
    let prevHome: string | undefined;

    before(() => {
        home = mkdtempSync(join(tmpdir(), "taco-grant-home-"));
        prevHome = process.env.TACO_HOME;
        process.env.TACO_HOME = home;
    });

    after(() => {
        if (prevHome === undefined) {
            Reflect.deleteProperty(process.env, "TACO_HOME");
        } else {
            process.env.TACO_HOME = prevHome;
        }
        rmSync(home, { recursive: true, force: true });
    });

    it("accepts an ordinary directory", () => {
        const dir = mkdtempSync(join(tmpdir(), "taco-grant-ok-"));
        try {
            assert.deepEqual(checkGrantRootSafety(dir), { ok: true });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects a relative path and an IM workspace id", () => {
        const relative = checkGrantRootSafety("relative/dir");
        assert.equal(relative.ok, false);
        const im = checkGrantRootSafety("im://wechat/peer/chat");
        assert.equal(im.ok, false);
    });

    it("rejects the Taco home and anything inside it", () => {
        // taco.json holds the provider API keys and the shell permission
        // rules. A grant that reaches it lets the model turn off every later
        // approval.
        const inside = join(home, "sessions");
        mkdirSync(inside, { recursive: true });
        assert.equal(checkGrantRootSafety(home).ok, false);
        assert.equal(checkGrantRootSafety(inside).ok, false);
    });

    it("rejects a directory that contains the Taco home", () => {
        // The other direction: a root above $TACO_HOME would let the grant
        // reach taco.json by a relative path.
        const parent = mkdtempSync(join(tmpdir(), "taco-grant-above-"));
        const homeInsideParent = join(parent, "home");
        mkdirSync(homeInsideParent, { recursive: true });
        const prev = process.env.TACO_HOME;
        process.env.TACO_HOME = homeInsideParent;
        try {
            assert.equal(checkGrantRootSafety(homeInsideParent).ok, false);
            assert.equal(checkGrantRootSafety(parent).ok, false);
        } finally {
            process.env.TACO_HOME = prev;
            rmSync(parent, { recursive: true, force: true });
        }
    });

    it("rejects the filesystem root and the home directory", () => {
        assert.equal(checkGrantRootSafety(parse(homedir()).root).ok, false);
        assert.equal(checkGrantRootSafety(homedir()).ok, false);
    });
});

describe("IM policy custom execution directory", () => {
    let home: string;
    let storeHome: string;
    let store: ImWorkspacePolicyStore;
    let prevHome: string | undefined;

    const ROUTE = { channelId: "wechat", peerId: "u1", chatId: "c1" };

    before(() => {
        home = mkdtempSync(join(tmpdir(), "taco-policy-home-"));
        storeHome = mkdtempSync(join(tmpdir(), "taco-policy-store-"));
        prevHome = process.env.TACO_HOME;
        process.env.TACO_HOME = home;
        store = new ImWorkspacePolicyStore(storeHome);
    });

    after(() => {
        if (prevHome === undefined) {
            Reflect.deleteProperty(process.env, "TACO_HOME");
        } else {
            process.env.TACO_HOME = prevHome;
        }
        rmSync(home, { recursive: true, force: true });
        rmSync(storeHome, { recursive: true, force: true });
    });

    it("refuses to store a custom execution directory inside the Taco home", async () => {
        await assert.rejects(
            () =>
                store.setChannelDefault("wechat", {
                    executionDir: { mode: "custom", path: join(home, "work") },
                }),
            /Taco home directory/,
        );
        await assert.rejects(
            () =>
                store.setChatOverride(ROUTE, {
                    executionDir: { mode: "custom", path: home },
                }),
            /Taco home directory/,
        );
    });

    it("stores an ordinary custom execution directory", async () => {
        const dir = mkdtempSync(join(tmpdir(), "taco-policy-work-"));
        try {
            await store.setChannelDefault("wechat", {
                executionDir: { mode: "custom", path: dir },
            });
            assert.deepEqual(store.resolve(ROUTE).executionDir, {
                mode: "custom",
                path: dir,
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("falls back to the shared scratch when a hand-edited policy names a refused root", () => {
        // The write path refuses such a directory, but a policy file can still
        // be edited by hand or written by an older build. The runtime must
        // refuse it too rather than hand the model the Taco home.
        const sessionsRoot = mkdtempSync(join(tmpdir(), "taco-policy-sessions-"));
        try {
            const result = resolveImExecutionCwd({
                sessionsRoot,
                route: ROUTE,
                policy: {
                    tools: { fsTools: "allow", shell: "allow" },
                    commands: { mode: "ask" },
                    executionDir: { mode: "custom", path: home },
                },
            });
            assert.equal(result.executionCwd, join(sessionsRoot, "scratch"));
            assert.ok(result.warning, "a refused directory must be reported");
        } finally {
            rmSync(sessionsRoot, { recursive: true, force: true });
        }
    });
});
