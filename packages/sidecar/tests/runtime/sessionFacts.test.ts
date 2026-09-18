/**
 * SessionFacts helpers — hide-from-list classification and the
 * write-if-absent guard used when restoring a v3 metadata bag.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/runtime/sessionFacts.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { JsonlSessionRepo, uuidv7 } from "../../src/runtime/pi/values.ts";
import {
    isHiddenSubagentSession,
    resolveParentDepth,
    type SessionFacts,
    writeSessionFacts,
} from "../../src/runtime/session/sessionFacts.ts";
import { readSessionMetadataFromDisk } from "../../src/runtime/session/sessionMetadataReader.ts";

describe("isHiddenSubagentSession", () => {
    it("hides an explicit subagent fact regardless of header parent", () => {
        const facts: SessionFacts = { kind: "subagent" };
        assert.equal(isHiddenSubagentSession(facts), true);
        assert.equal(isHiddenSubagentSession(facts, "parent-id"), true);
    });

    it("keeps an explicit main session visible even with a header parent", () => {
        // kind:main is the user-session marker. A header parent without
        // kind:subagent would be a fork, which sidecar does not currently
        // expose, but the kind flag must still win so a future fork path
        // cannot hide a labelled main session.
        assert.equal(isHiddenSubagentSession({ kind: "main" }, "parent-id"), false);
        assert.equal(isHiddenSubagentSession({ kind: "main" }), false);
    });

    it("hides a session whose header carries parentSessionId when kind is absent", () => {
        // The create→writeSessionFacts window: the file exists, facts are
        // still {}, but repo.create already stamped parentSessionId.
        assert.equal(isHiddenSubagentSession({}, "parent-id"), true);
    });

    it("hides a session whose facts carry parentSessionId when kind is absent", () => {
        // Restored v3 metadata, or a facts write that recorded the parent
        // before kind made it onto disk.
        assert.equal(isHiddenSubagentSession({ parentSessionId: "parent-id" }), true);
    });

    it("keeps a facts-less session with no parent visible — legacy user sessions", () => {
        assert.equal(isHiddenSubagentSession({}), false);
        assert.equal(isHiddenSubagentSession({ agentType: "explorer" }), false);
    });
});

describe("resolveParentDepth", () => {
    it("returns the stored depth when present", () => {
        assert.equal(resolveParentDepth({ depth: 2 }, {}), 2);
        assert.equal(resolveParentDepth({ kind: "subagent", depth: 1 }, {}), 1);
    });

    it("defaults a facts-less user session to 0 without treating it as broken", () => {
        // Main sessions never write taco.session.facts. Spawning from one
        // must be depth 0, not a warning-worthy failure.
        assert.equal(resolveParentDepth({}, { parentSessionId: "main" }), 0);
        assert.equal(resolveParentDepth({ kind: "main" }, {}), 0);
    });

    it("defaults a subagent-looking parent with no depth to 0", () => {
        assert.equal(resolveParentDepth({ kind: "subagent" }, {}), 0);
        assert.equal(resolveParentDepth({ parentSessionId: "p" }, {}), 0);
    });
});

describe("writeSessionFacts / scanner contract", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
        dirs.length = 0;
    });

    it("is the namespace writeSessionFacts persists and the scanner reads", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "taco-facts-cwd-"));
        const sessionsRoot = mkdtempSync(join(tmpdir(), "taco-facts-sessions-"));
        dirs.push(cwd, sessionsRoot);
        const env = new NodeExecutionEnv({ cwd });
        const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot });
        const id = uuidv7();
        const session = await repo.create({ id, cwd }, harnessContext);
        const path = session.metadata.path;
        await writeSessionFacts(session, {
            kind: "subagent",
            agentType: "explorer",
            depth: 1,
            parentSessionId: "parent-1",
        });
        await session.close(harnessContext);

        const { facts } = await readSessionMetadataFromDisk(path);
        assert.equal(facts.kind, "subagent");
        assert.equal(facts.agentType, "explorer");
        assert.equal(facts.depth, 1);
        assert.equal(facts.parentSessionId, "parent-1");
    });
});
