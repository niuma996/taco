/**
 * WorkspaceAssociationStore — the associated-directory sets.
 *
 * The store is the sidecar's own file: every client reads the same sets, so
 * a change made in one reaches the others. These cover the two scope levels,
 * the fallback between them, and the rules that keep a grant from reaching
 * further than the user meant.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    AssociationValidationError,
    WorkspaceAssociationStore,
} from "../../src/workspace/associationStore.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

// The store's Taco-home exclusion is checked against the REAL $TACO_HOME,
// so the test must point it at a temp dir rather than the developer's.
const home = useTempTacoHome("assoc");

describe("WorkspaceAssociationStore", () => {
    let workspaceDir: string;
    let otherDir: string;
    let store: WorkspaceAssociationStore;

    beforeEach(() => {
        workspaceDir = mkdtempSync(join(tmpdir(), "taco-assoc-ws-"));
        otherDir = mkdtempSync(join(tmpdir(), "taco-assoc-other-"));
        store = new WorkspaceAssociationStore({ home });
    });

    afterEach(() => {
        rmSync(workspaceDir, { recursive: true, force: true });
        rmSync(otherDir, { recursive: true, force: true });
    });

    it("stores and reads a workspace-scoped set", async () => {
        await store.set({ scope: "workspace", id: workspaceDir }, [otherDir]);
        assert.deepEqual(store.get({ scope: "workspace", id: workspaceDir }), [otherDir]);
    });

    it("normalizes the key so the same directory is one entry", async () => {
        await store.set({ scope: "workspace", id: workspaceDir }, [otherDir]);
        // A trailing separator is the same directory.
        const withSlash = workspaceDir.endsWith("/") ? workspaceDir : `${workspaceDir}/`;
        assert.deepEqual(store.get({ scope: "workspace", id: withSlash }), [otherDir]);
    });

    it("removes the entry when the set becomes empty", async () => {
        await store.set({ scope: "workspace", id: workspaceDir }, [otherDir]);
        await store.set({ scope: "workspace", id: workspaceDir }, []);
        assert.deepEqual(store.get({ scope: "workspace", id: workspaceDir }), []);
    });

    it("falls back from a conversation to its channel", async () => {
        const channel = "test-channel";
        const conversation = `im://${channel}/peer/chat`;
        await store.set({ scope: "channel", id: channel }, [otherDir]);
        const resolved = store.resolve(conversation as never);
        assert.deepEqual(resolved.roots, [otherDir]);
        assert.deepEqual(resolved.source, { scope: "channel", id: channel });
    });

    it("prefers a conversation's own set over the channel's", async () => {
        const channel = "test-channel";
        const conversation = `im://${channel}/peer/chat`;
        const own = mkdtempSync(join(tmpdir(), "taco-assoc-own-"));
        try {
            await store.set({ scope: "channel", id: channel }, [otherDir]);
            await store.set({ scope: "workspace", id: conversation }, [own]);
            const resolved = store.resolve(conversation as never);
            assert.deepEqual(resolved.roots, [own]);
            assert.deepEqual(resolved.source, { scope: "workspace", id: conversation });
        } finally {
            rmSync(own, { recursive: true, force: true });
        }
    });

    it("falls back to the channel when a conversation's own set is emptied", async () => {
        const channel = "test-channel";
        const conversation = `im://${channel}/peer/chat`;
        const own = mkdtempSync(join(tmpdir(), "taco-assoc-own-"));
        try {
            await store.set({ scope: "channel", id: channel }, [otherDir]);
            await store.set({ scope: "workspace", id: conversation }, [own]);
            // Emptying the conversation's own set removes the entry, so the
            // conversation inherits the channel's again.
            await store.set({ scope: "workspace", id: conversation }, []);
            const resolved = store.resolve(conversation as never);
            assert.deepEqual(resolved.roots, [otherDir]);
            assert.deepEqual(resolved.source, { scope: "channel", id: channel });
        } finally {
            rmSync(own, { recursive: true, force: true });
        }
    });

    it("gives a filesystem workspace no channel fallback", async () => {
        await store.set({ scope: "channel", id: "test-channel" }, [otherDir]);
        const resolved = store.resolve(workspaceDir as never);
        assert.deepEqual(resolved.roots, []);
        assert.equal(resolved.source, undefined);
    });

    it("rejects a root that is not absolute", async () => {
        await assert.rejects(
            () => store.set({ scope: "workspace", id: workspaceDir }, ["relative/path"]),
            AssociationValidationError,
        );
    });

    it("rejects a root that does not exist", async () => {
        await assert.rejects(
            () => store.set({ scope: "workspace", id: workspaceDir }, [join(home, "nope")]),
            AssociationValidationError,
        );
    });

    it("rejects a root that is not a directory", async () => {
        const file = join(home, "a-file");
        writeFileSync(file, "x");
        await assert.rejects(
            () => store.set({ scope: "workspace", id: workspaceDir }, [file]),
            AssociationValidationError,
        );
    });

    it("rejects an IM workspace as a root", async () => {
        await assert.rejects(
            () => store.set({ scope: "workspace", id: workspaceDir }, ["im://chan/peer/chat"]),
            AssociationValidationError,
        );
    });

    it("rejects a root that contains the workspace directory", async () => {
        // Granting an ancestor would widen the workspace's reach beyond the
        // directory the user picked.
        const parent = mkdtempSync(join(tmpdir(), "taco-assoc-parent-"));
        const child = join(parent, "project");
        mkdirSync(child, { recursive: true });
        try {
            await assert.rejects(
                () => store.set({ scope: "workspace", id: child }, [parent]),
                AssociationValidationError,
            );
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });

    it("rejects a root inside the Taco home", async () => {
        // taco.json holds API keys and the shell permission rules.
        await assert.rejects(
            () => store.set({ scope: "workspace", id: workspaceDir }, [home]),
            AssociationValidationError,
        );
    });

    it("rejects a root that contains the Taco home", async () => {
        // The other direction: a root above $TACO_HOME would let the grant
        // reach taco.json by a relative path.
        const parent = mkdtempSync(join(tmpdir(), "taco-assoc-above-"));
        const fakeHome = join(parent, "home");
        mkdirSync(fakeHome, { recursive: true });
        const prev = process.env.TACO_HOME;
        process.env.TACO_HOME = fakeHome;
        try {
            await assert.rejects(
                () => store.set({ scope: "workspace", id: workspaceDir }, [parent]),
                AssociationValidationError,
            );
        } finally {
            process.env.TACO_HOME = prev;
            rmSync(parent, { recursive: true, force: true });
        }
    });

    it("deduplicates a root listed twice", async () => {
        const stored = await store.set({ scope: "workspace", id: workspaceDir }, [
            otherDir,
            otherDir,
        ]);
        assert.deepEqual(stored, [otherDir]);
    });

    it("serializes read-modify-write across store instances", async () => {
        const first = new WorkspaceAssociationStore({ home });
        const second = new WorkspaceAssociationStore({ home });

        await Promise.all([
            first.set({ scope: "workspace", id: workspaceDir }, [otherDir]),
            second.set({ scope: "channel", id: "shared-channel" }, [workspaceDir]),
        ]);

        assert.deepEqual(first.get({ scope: "workspace", id: workspaceDir }), [otherDir]);
        assert.deepEqual(second.get({ scope: "channel", id: "shared-channel" }), [workspaceDir]);
    });

    it("survives a corrupt document without throwing", () => {
        writeFileSync(join(home, "workspace-associations.json"), "{ not json");
        const fresh = new WorkspaceAssociationStore({ home });
        assert.deepEqual(fresh.get({ scope: "workspace", id: workspaceDir }), []);
    });
});
