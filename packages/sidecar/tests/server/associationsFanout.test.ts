/**
 * `workspace.associations_changed` fan-out — which workspaces a change
 * reaches, and in what shape the key travels.
 *
 * Registry keys carry the client's spelling of a directory, association
 * keys the writer's; the same directory spelled differently must still fan
 * out (matching normalizes both sides). The pushed key keeps the caller's
 * raw spelling — the wire contract is raw strings, and the client matches
 * what it sent.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/associationsFanout.test.ts
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { WorkspaceAssociationKey, WorkspaceId } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

useTempTacoHome("associations-fanout");

interface CapturedPush {
    method: string;
    workspace: string;
    key: WorkspaceAssociationKey;
}

/**
 * A bare server with two private seams stubbed for observation: the
 * workspace registry the fan-out iterates (registering real runtimes would
 * pull in the full workspace stack) and the push sink.
 */
function makeFanoutRecorder(cwds: string[]): { server: SidecarServer; pushes: CapturedPush[] } {
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const pushes: CapturedPush[] = [];
    const seams = server as unknown as {
        workspaces: { publish: (cwd: WorkspaceId, ws: never) => void };
        emitPush: (
            method: string,
            workspace: string,
            session: unknown,
            params: { key: WorkspaceAssociationKey },
        ) => void;
    };
    for (const cwd of cwds) {
        seams.workspaces.publish(cwd as WorkspaceId, {} as never);
    }
    seams.emitPush = (method, workspace, _session, params) => {
        pushes.push({ method, workspace, key: params.key });
    };
    return { server, pushes };
}

describe("workspace.associations_changed fan-out", () => {
    it("reaches a workspace whose registry spelling differs from the writer's, with the raw key", async () => {
        const root = mkdtempSync(join(tmpdir(), "assoc-root-"));
        const { server, pushes } = makeFanoutRecorder(["/tmp/a/../proj", "/tmp/other"]);

        await server.associations.set({ scope: "workspace", id: "/tmp/proj" }, [root]);

        assert.equal(pushes.length, 1);
        assert.equal(pushes[0].method, "workspace.associations_changed");
        assert.equal(pushes[0].workspace, "/tmp/a/../proj");
        assert.deepEqual(pushes[0].key, { scope: "workspace", id: "/tmp/proj" });
    });

    it("fans a channel-scope change to that channel's IM conversations only", async () => {
        const root = mkdtempSync(join(tmpdir(), "assoc-root-"));
        const { server, pushes } = makeFanoutRecorder([
            "im://chan-1/peer-1/chat-1",
            "im://chan-2/peer-1/chat-1",
            "/tmp/local",
        ]);

        await server.associations.set({ scope: "channel", id: "chan-1" }, [root]);

        assert.equal(pushes.length, 1);
        assert.equal(pushes[0].workspace, "im://chan-1/peer-1/chat-1");
    });
});
