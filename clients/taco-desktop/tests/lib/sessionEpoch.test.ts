import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionEpochs } from "../../src/lib/sessionEpoch.ts";

describe("SessionEpochs", () => {
    it("returns 'new' on first observe, 'unchanged' on repeat, 'replaced' on instance change", () => {
        const epochs = new SessionEpochs();
        assert.equal(epochs.observe("/ws/a", "sess-1", "inst-A"), "new");
        assert.equal(epochs.observe("/ws/a", "sess-1", "inst-A"), "unchanged");
        assert.equal(epochs.observe("/ws/a", "sess-1", "inst-B"), "replaced");
    });

    it("treats (workspace, sessionId) pairs independently", () => {
        const epochs = new SessionEpochs();
        assert.equal(epochs.observe("/ws/a", "sess-1", "inst-A"), "new");
        assert.equal(epochs.observe("/ws/a", "sess-2", "inst-A"), "new");
        assert.equal(epochs.observe("/ws/b", "sess-1", "inst-A"), "new");
        // Replace only one; siblings stay unchanged.
        assert.equal(epochs.observe("/ws/a", "sess-1", "inst-B"), "replaced");
        assert.equal(epochs.observe("/ws/a", "sess-2", "inst-A"), "unchanged");
        assert.equal(epochs.observe("/ws/b", "sess-1", "inst-A"), "unchanged");
    });

    it("forget() drops the session", () => {
        const epochs = new SessionEpochs();
        epochs.observe("/ws/a", "sess-1", "inst-A");
        epochs.forget("/ws/a", "sess-1");
        // After forget, observe again returns "new" (not "unchanged").
        assert.equal(epochs.observe("/ws/a", "sess-1", "inst-A"), "new");
    });

    it("clearWorkspace() drops only sessions in that workspace", () => {
        const epochs = new SessionEpochs();
        epochs.observe("/ws/a", "sess-1", "inst-A");
        epochs.observe("/ws/a", "sess-2", "inst-A");
        epochs.observe("/ws/b", "sess-1", "inst-A");
        epochs.clearWorkspace("/ws/a");
        // /ws/a/* forgotten, /ws/b untouched.
        assert.equal(epochs.observe("/ws/a", "sess-1", "inst-A"), "new");
        assert.equal(epochs.observe("/ws/a", "sess-2", "inst-A"), "new");
        assert.equal(epochs.observe("/ws/b", "sess-1", "inst-A"), "unchanged");
    });

    it("clearAll() drops every session", () => {
        const epochs = new SessionEpochs();
        epochs.observe("/ws/a", "sess-1", "inst-A");
        epochs.observe("/ws/b", "sess-1", "inst-A");
        epochs.clearAll();
        assert.equal(epochs.observe("/ws/a", "sess-1", "inst-A"), "new");
        assert.equal(epochs.observe("/ws/b", "sess-1", "inst-A"), "new");
    });

    it("entries() yields every tracked (workspace, sessionId, instanceId)", () => {
        const epochs = new SessionEpochs();
        epochs.observe("/ws/a", "sess-1", "inst-A");
        epochs.observe("/ws/a", "sess-2", "inst-A");
        epochs.observe("/ws/b", "sess-1", "inst-B");
        const seen = new Map<string, string>();
        for (const entry of epochs.entries()) {
            seen.set(`${entry.workspace}|${entry.sessionId}`, entry.instanceId);
        }
        assert.equal(seen.size, 3);
        assert.equal(seen.get("/ws/a|sess-1"), "inst-A");
        assert.equal(seen.get("/ws/a|sess-2"), "inst-A");
        assert.equal(seen.get("/ws/b|sess-1"), "inst-B");
    });

    it("workspaces with ':' or '/' in the name don't collide with the separator", () => {
        const epochs = new SessionEpochs();
        epochs.observe("/ws:a", "sess-1", "inst-A");
        epochs.observe("/ws", "a|sess-1", "inst-A"); // sessionId with separator-looking content
        // Two distinct sessions; iteration must round-trip both without merging.
        const keys: string[] = [];
        for (const entry of epochs.entries()) {
            keys.push(`${entry.workspace}|${entry.sessionId}`);
        }
        assert.equal(keys.length, 2);
        assert.ok(keys.includes("/ws:a|sess-1"));
        assert.ok(keys.includes("/ws|a|sess-1"));
    });

    it("handles the daemon-restart pattern: replaced-on-instance is the only way to detect process change", () => {
        // The motivating scenario for the synthetic sweep in observeHello:
        // a daemon restart drops every Attached push (the new daemon
        // attaches from scratch), so the only signal that an old session
        // existed is its entry in SessionEpochs at the moment hello arrives.
        // We model that here: track three sessions on inst-A, simulate
        // hello(inst-B), and verify the entries() sweep yields all three
        // as "replaced" candidates (caller decides whether to emit each).
        const epochs = new SessionEpochs();
        epochs.observe("/ws/a", "sess-1", "inst-A");
        epochs.observe("/ws/a", "sess-2", "inst-A");
        epochs.observe("/ws/b", "sess-1", "inst-A");

        // Simulate a hello(inst-B) arriving. None of the sessions have
        // been observed under inst-B yet, so calling observe() now would
        // return "new" for each. The caller (tacoClientTauri.ts) iterates
        // entries() FIRST, emits "replaced" for each, then clearAll()s.
        const beforeRestart = [...epochs.entries()].map((e) => e.sessionId).sort();
        assert.deepEqual(beforeRestart, ["sess-1", "sess-1", "sess-2"]);

        // After clearAll (the synthetic sweep completes), tracking is
        // fresh for the new instance.
        epochs.clearAll();
        assert.equal(epochs.observe("/ws/a", "sess-1", "inst-B"), "new");
    });
});
