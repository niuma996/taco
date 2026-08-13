import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";

describe("workspace RPC routing", () => {
    it("routes workspace.ensure from params.cwd", async () => {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        let ensured: string | undefined;
        server.ensureWorkspace = async (cwd) => {
            ensured = cwd;
            return { cwd } as never;
        };

        const response = await server.dispatchRpc({
            id: "ensure-1",
            method: "workspace.ensure",
            params: { cwd: "/tmp/project-a" },
        });

        assert.deepEqual(response, { id: "ensure-1", ok: true, result: { cwd: "/tmp/project-a" } });
        assert.equal(ensured, "/tmp/project-a");
    });

    it("routes workspace.dispose from params.cwd", async () => {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        let disposed: string | undefined;
        server.disposeWorkspace = async (cwd) => {
            disposed = cwd;
        };

        const response = await server.dispatchRpc({
            id: "dispose-1",
            method: "workspace.dispose",
            params: { cwd: "/tmp/project-a" },
        });

        assert.deepEqual(response, { id: "dispose-1", ok: true, result: null });
        assert.equal(disposed, "/tmp/project-a");
    });
});
