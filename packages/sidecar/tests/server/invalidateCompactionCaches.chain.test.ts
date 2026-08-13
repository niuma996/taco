/**
 * Compaction cache invalidation integration test — verifies
 * SidecarServer.invalidateCompactionCaches() actually traverses the full
 * workspaceMap → WorkspaceRuntime → SessionRegistry → AttachedSession →
 * CompactionController.invalidate() chain, rather than calling the wrong
 * method or no-oping.
 *
 * Strategy: inject fake workspaces with spy'd registries/sessions/controllers,
 * call invalidateCompactionCaches(), then assert every facade was called.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";

let tmpDir: string;
let prevTacoHome: string | undefined;

before(() => {
    prevTacoHome = process.env.TACO_HOME;
    tmpDir = mkdtempSync(join(tmpdir(), "taco-facade-chain-"));
    process.env.TACO_HOME = tmpDir;
});

after(() => {
    if (prevTacoHome === undefined) {
        Reflect.deleteProperty(process.env, "TACO_HOME");
    } else {
        process.env.TACO_HOME = prevTacoHome;
    }
    rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Exposes SidecarServer's private workspaceMap via reflection, then injects fake workspaces.
 * Uses `as unknown as` to bypass the private modifier — test-only, not a production API.
 */
type WorkspaceMap = Map<string, FakeWorkspaceRuntime>;
function injectWorkspaceMap(server: SidecarServer, map: WorkspaceMap): void {
    (server as unknown as { workspaceMap: WorkspaceMap }).workspaceMap = map;
}

interface FakeWorkspaceRuntime {
    invalidateCompactionCache: () => void;
}

interface FakeSessionRegistry {
    invalidateAllCompactionCaches: () => void;
}

interface FakeAttachedSession {
    invalidateCompactionCache: () => void;
}

interface FakeCompactionController {
    invalidate: () => void;
}

describe("SidecarServer.invalidateCompactionCaches — facade chain", () => {
    it("walks workspaceMap → workspace → sessionRegistry → session → controller", () => {
        const controller1 = makeControllerSpy();
        const controller2 = makeControllerSpy();
        const session1 = makeSessionSpy(controller1);
        const session2 = makeSessionSpy(controller2);
        const registry = makeRegistrySpy([session1, session2]);
        const workspace = makeWorkspaceSpy(registry);

        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        injectWorkspaceMap(server, new Map([["/proj/a", workspace]]));

        // Call the facade entry point
        server.invalidateCompactionCaches();

        // Every layer in the chain reaches its correct downstream target:
        assert.deepEqual(workspace.calls, ["invalidateCompactionCache"]);
        assert.deepEqual(registry.calls, ["invalidateAllCompactionCaches"]);
        assert.deepEqual(session1.calls, ["invalidateCompactionCache"]);
        assert.deepEqual(session2.calls, ["invalidateCompactionCache"]);
        assert.deepEqual(controller1.calls, ["invalidate"]);
        assert.deepEqual(controller2.calls, ["invalidate"]);
    });

    it("works with multiple workspaces across the chain", () => {
        const ws1Controller1 = makeControllerSpy();
        const ws1Controller2 = makeControllerSpy();
        const ws1Session1 = makeSessionSpy(ws1Controller1);
        const ws1Session2 = makeSessionSpy(ws1Controller2);
        const ws1Registry = makeRegistrySpy([ws1Session1, ws1Session2]);
        const ws1 = makeWorkspaceSpy(ws1Registry);

        const ws2Controller = makeControllerSpy();
        const ws2Session = makeSessionSpy(ws2Controller);
        const ws2Registry = makeRegistrySpy([ws2Session]);
        const ws2 = makeWorkspaceSpy(ws2Registry);

        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        injectWorkspaceMap(
            server,
            new Map([
                ["/proj/one", ws1],
                ["/proj/two", ws2],
            ]),
        );

        server.invalidateCompactionCaches();

        // ws1: 2 sessions × their own controller
        assert.equal(ws1.calls.length, 1);
        assert.equal(ws1Registry.calls.length, 1);
        assert.equal(ws1Session1.calls.length, 1);
        assert.equal(ws1Session2.calls.length, 1);
        assert.equal(ws1Controller1.calls.length, 1);
        assert.equal(ws1Controller2.calls.length, 1);

        // ws2: 1 session
        assert.equal(ws2.calls.length, 1);
        assert.equal(ws2Registry.calls.length, 1);
        assert.equal(ws2Session.calls.length, 1);
        assert.equal(ws2Controller.calls.length, 1);
    });

    it("no-op on empty workspaceMap (still safe to call)", () => {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        injectWorkspaceMap(server, new Map());

        // Must not throw
        server.invalidateCompactionCaches();
    });
});

// ─── spy factories ──────────────────────────────────────────────────────────────

function makeControllerSpy(): FakeCompactionController & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        invalidate() {
            calls.push("invalidate");
        },
    };
}

function makeSessionSpy(
    controller: FakeCompactionController,
): FakeAttachedSession & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        invalidateCompactionCache() {
            calls.push("invalidateCompactionCache");
            controller.invalidate();
        },
    };
}

function makeRegistrySpy(
    sessions: FakeAttachedSession[],
): FakeSessionRegistry & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        invalidateAllCompactionCaches() {
            calls.push("invalidateAllCompactionCaches");
            for (const s of sessions) s.invalidateCompactionCache();
        },
    };
}

function makeWorkspaceSpy(
    registry: FakeSessionRegistry,
): FakeWorkspaceRuntime & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        invalidateCompactionCache() {
            calls.push("invalidateCompactionCache");
            registry.invalidateAllCompactionCaches();
        },
    };
}
