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
    it("hides only when a parent shows up somewhere", () => {
        // The create→writeSessionFacts window: the file exists, facts are
        // still {}, but repo.create already stamped parentSessionId.
        //
        // Restored v3 metadata, or a facts write that recorded the parent
        // before kind made it onto disk.
        //
        // kind:main is the user-session marker. A header parent without
        // kind:subagent would be a fork, which sidecar does not currently
        // expose, but the kind flag must still win so a future fork path
        // cannot hide a labelled main session.
        const cases: Array<{
            label: string;
            facts: SessionFacts;
            headerParentSessionId?: string;
            hidden: boolean;
        }> = [
            { label: "explicit subagent fact", facts: { kind: "subagent" }, hidden: true },
            {
                label: "explicit subagent fact + header parent",
                facts: { kind: "subagent" },
                headerParentSessionId: "parent-id",
                hidden: true,
            },
            {
                label: "labelled main + header parent",
                facts: { kind: "main" },
                headerParentSessionId: "parent-id",
                hidden: false,
            },
            { label: "labelled main", facts: { kind: "main" }, hidden: false },
            {
                label: "header parentSessionId with kind absent",
                facts: {},
                headerParentSessionId: "parent-id",
                hidden: true,
            },
            {
                label: "facts parentSessionId with kind absent",
                facts: { parentSessionId: "parent-id" },
                hidden: true,
            },
            { label: "no parent anywhere — legacy user session", facts: {}, hidden: false },
            { label: "agentType only", facts: { agentType: "explorer" }, hidden: false },
        ];
        for (const { label, facts, headerParentSessionId, hidden } of cases) {
            assert.equal(isHiddenSubagentSession(facts, headerParentSessionId), hidden, label);
        }
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
