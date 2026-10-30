/**
 * WorkspaceRuntime policy wiring: skill hot reload (unit + real watcher),
 * subagent primitives, and the permission-broker rule/policy thunks.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
    asSessionId,
    asWorkspaceId,
    type SessionId,
    type SkillDiagnosticEntry,
} from "@taco-ai/protocol";
import type { AgentDefinition } from "../../src/agents/types.ts";
import type { ImWorkspacePolicy } from "../../src/channels/imWorkspacePolicy.ts";
import { WorkspaceExtensionSet } from "../../src/extensions/activation.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { type SessionFacts, writeSessionFacts } from "../../src/runtime/session/sessionFacts.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import type { TacoSkill } from "../../src/skills/tacoSkill.ts";
import type { TacoTool } from "../../src/tools/index.ts";
import { createWorkspaceScope } from "../../src/workspace/workspaceScope.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";
import { stubModelFetch } from "../_helpers/stubModelFetch.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";
import { createTestWorkspace } from "../_helpers/testWorkspace.ts";

/**
 * WorkspaceRuntime.reloadSkillsNow — unit-level coverage using a stub
 * `reloadSkills` callback (no real filesystem/chokidar involved; that's
 * covered separately by the real-chokidar describe below).
 *
 * Verifies the three things a hot reload is supposed to update:
 *  - `resources.skills` (skills.list RPC reads this)
 *  - `systemPrompt` (the baked <available_skills> section used by the next attach)
 *  - the live skill list SessionRegistry.getListingTools()'s skill tool resolves
 *
 * Also verifies the documented limitation: reload with no `reloadSkills`
 * callback configured (the constructor-test default) is a safe no-op, not a
 * throw — matters because `dispose()` and other paths call into a
 * WorkspaceRuntime that many existing tests construct without hot-reload
 * wiring at all.
 */

function mkSkill(name: string): TacoSkill {
    return {
        name,
        description: `${name} desc`,
        filePath: `/tmp/${name}/SKILL.md`,
        content: `# ${name}`,
        source: "user",
    };
}

let tmpDirSkillReload: string;

describe("WorkspaceRuntime.reloadSkillsNow", () => {
    before(() => {
        tmpDirSkillReload = mkdtempSync(join(tmpdir(), "taco-ws-skillreload-"));
    });

    after(() => {
        rmSync(tmpDirSkillReload, { recursive: true, force: true });
    });

    it("is a no-op when no reloadSkills callback was configured", async () => {
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(tmpDirSkillReload),
            resources: { skills: [mkSkill("alpha")] },
        });
        const promptBefore = ws.systemPrompt;
        await ws.reloadSkillsNow();
        assert.equal(
            ws.systemPrompt,
            promptBefore,
            "prompt must not change with no callback wired",
        );
        assert.equal(ws.resources.skills?.length, 1);
        await ws.dispose();
    });

    it("updates resources.skills, systemPrompt, and live skill-tool lookup", async () => {
        let scanCount = 0;
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(tmpDirSkillReload),
            resources: { skills: [mkSkill("alpha")] },
            skillDirs: [tmpDirSkillReload],
            reloadSkills: async () => {
                scanCount++;
                return { skills: [mkSkill("beta")], diagnostics: [] };
            },
        });

        assert.ok(!ws.systemPrompt.includes("beta"), "beta must not be in the prompt yet");

        await ws.reloadSkillsNow();

        assert.equal(scanCount, 1);
        assert.equal(ws.resources.skills?.length, 1);
        assert.equal(ws.resources.skills?.[0]?.name, "beta");
        // SessionRegistry separately supplies `resources` to each new
        // AttachedSession's AgentHarness. This equality is the regression
        // guard for the bug where reload only replaced WorkspaceRuntime's
        // object, leaving newly-attached harnesses on the pre-reload list.
        assert.equal(ws.sessionRegistry.resources.skills?.[0]?.name, "beta");
        assert.notEqual(
            ws.sessionRegistry.resources,
            ws.resources,
            "each layer owns its resource object but both must carry the same skills",
        );
        assert.ok(
            ws.systemPrompt.includes("beta"),
            "expected the rebuilt system prompt to mention the new skill",
        );
        assert.ok(
            !ws.systemPrompt.includes("alpha desc"),
            "expected the stale skill's description to be gone from the rebuilt prompt",
        );

        // Live lookup: SessionRegistry.updateSkills should have been called
        // too, so a freshly-built skill tool resolves "beta" and not "alpha".
        const listing = ws.sessionRegistry.getListingTools();
        const skillTool = listing.find((t) => t.name === "skill");
        assert.ok(skillTool, "expected a skill tool in getListingTools()");
        const found = (await invokeTool(skillTool, { skill: "beta" }, undefined, {
            toolCallId: "tc-1",
        })) as { details?: { found: boolean } };
        assert.equal(found.details?.found, true);
        const stale = (await invokeTool(skillTool, { skill: "alpha" }, undefined, {
            toolCallId: "tc-2",
        })) as { details?: { found: boolean } };
        assert.equal(stale.details?.found, false);

        await ws.dispose();
    });

    it("keeps the same systemPrompt string when a rescan finds no content change", async () => {
        // Regression guard: a KV-cache-safe reload must not pay a rebuild
        // (and thus a cache miss for the next attach) when the rescanned
        // skill list renders to the exact same prompt as before.
        let scanCount = 0;
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(tmpDirSkillReload),
            resources: { skills: [mkSkill("alpha")] },
            skillDirs: [tmpDirSkillReload],
            reloadSkills: async () => {
                scanCount++;
                return { skills: [mkSkill("alpha")], diagnostics: [] };
            },
        });

        const promptBefore = ws.systemPrompt;
        await ws.reloadSkillsNow();

        assert.equal(scanCount, 1);
        assert.equal(
            ws.systemPrompt,
            promptBefore,
            "identical rescan content must not replace the systemPrompt string",
        );

        await ws.dispose();
    });

    it("collapses concurrent reload calls into one scan (SingleFlight)", async () => {
        let scanCount = 0;
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(tmpDirSkillReload),
            resources: { skills: [] },
            skillDirs: [tmpDirSkillReload],
            reloadSkills: async () => {
                scanCount++;
                await new Promise((r) => setTimeout(r, 20));
                return { skills: [mkSkill("gamma")], diagnostics: [] };
            },
        });

        await Promise.all([ws.reloadSkillsNow(), ws.reloadSkillsNow(), ws.reloadSkillsNow()]);

        assert.equal(scanCount, 1, "three concurrent calls should share one in-flight scan");
        assert.equal(ws.resources.skills?.[0]?.name, "gamma");

        await ws.dispose();
    });

    it("replaces the previous diagnostics set on reload, rather than merging", async () => {
        // Regression guard: a fix on disk must silence its own warning.
        // Without replacement semantics a SKILL.md the user just repaired would
        // keep showing up as broken, which is exactly the silent-doesn't-apply
        // behavior hot reload was supposed to fix.
        const stale: SkillDiagnosticEntry = {
            code: "parse_failed",
            message: "old broken state",
            path: "/stale/SKILL.md",
        };
        const next: SkillDiagnosticEntry = {
            code: "duplicate_name",
            message: "fresh shadowing",
            path: "/fresh/SKILL.md",
        };
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(tmpDirSkillReload),
            resources: { skills: [] },
            skillDiagnostics: [stale],
            skillDirs: [tmpDirSkillReload],
            reloadSkills: async () => ({ skills: [], diagnostics: [next] }),
        });

        assert.deepEqual(ws.skillDiagnostics, [stale], "constructor seed must round-trip");
        await ws.reloadSkillsNow();
        assert.deepEqual(ws.skillDiagnostics, [next], "reload must replace, not append");
        assert.ok(
            !ws.skillDiagnostics.includes(stale),
            "a fixed file must stop being reported after the reload that fixed it",
        );

        await ws.dispose();
    });
});

/**
 * Real-filesystem, real-chokidar coverage for skill hot reload — the first
 * fs-watcher test in this codebase. Kept as a single targeted case rather
 * than a full suite: real fs event timing can be flaky in CI, so this only
 * proves the wiring (watch → debounce → reloadSkillsNow → resources.skills)
 * works end to end; the pure logic (dedup, frontmatter, prompt rebuild) is
 * covered by the reloadSkillsNow tests above and skillFrontmatter tests with
 * stub callbacks instead of a live watcher.
 *
 * Uses a bounded poll (2s budget) rather than a fixed sleep, since the
 * debounce (300ms) plus OS fs-event latency isn't perfectly deterministic.
 */

async function waitFor(
    predicate: () => boolean,
    timeoutMs: number,
    intervalMs = 50,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    if (!predicate()) {
        throw new Error(`condition not met within ${timeoutMs}ms`);
    }
}

let skillsDir: string;
let tmpDirSkillWatch: string;

describe("WorkspaceRuntime skill fs watcher (real chokidar)", () => {
    before(() => {
        tmpDirSkillWatch = mkdtempSync(join(tmpdir(), "taco-ws-skillwatch-"));
        skillsDir = join(tmpDirSkillWatch, "skills");
        // Pre-create the skill dir BEFORE the watcher starts. Creating a new
        // directory and its SKILL.md in the same synchronous burst lets Chokidar
        // discover the file while scanning the new directory's *initial* entries;
        // with ignoreInitial:true it correctly suppresses that event. This test
        // needs an already-watched directory so the later file write is
        // unambiguously a post-ready `add` event.
        mkdirSync(join(skillsDir, "watched-skill"), { recursive: true });
    });

    after(() => {
        rmSync(tmpDirSkillWatch, { recursive: true, force: true });
    });

    it("picks up a newly-written SKILL.md without an explicit reload call", async () => {
        let scanResult: TacoSkill[] = [];
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(tmpDirSkillWatch),
            resources: { skills: [] },
            skillDirs: [skillsDir],
            // Stub scan: real directory scanning (loadSourcedSkills etc.) is
            // SidecarServer's job and is exercised elsewhere (server.skillsDedupe
            // tests). This test only needs to prove the fs event reaches
            // reloadSkillsNow — the callback just needs to return *something*
            // that changed, so resources.skills is verifiable proof the watcher
            // fired.
            reloadSkills: async () => ({ skills: scanResult, diagnostics: [] }),
        });

        try {
            // Chokidar ignores initial entries by design. Without awaiting its
            // `ready` event, a busy parallel test run can create the skill
            // while Chokidar still classifies the directory as initial state,
            // then legitimately emit no post-ready `add` event. The production
            // startup scan already covers files written before readiness; this
            // test is specifically proving a *post-ready* fs change reloads.
            await ws.skillWatcherReady;

            const newSkillDir = join(skillsDir, "watched-skill");
            scanResult = [
                {
                    name: "watched-skill",
                    description: "written after construction",
                    filePath: join(newSkillDir, "SKILL.md"),
                    content: "# watched-skill",
                    source: "user",
                },
            ];
            writeFileSync(join(newSkillDir, "SKILL.md"), "---\nname: watched-skill\n---\nbody");

            await waitFor(
                () => (ws.resources.skills?.length ?? 0) > 0,
                2000,
                // A single fs event triggers a 300ms debounce timer inside
                // WorkspaceRuntime before reloadSkillsNow runs; poll at a
                // strictly finer grain than that so the loop doesn't
                // overshoot the debounce window on the first check.
                40,
            );

            assert.equal(ws.resources.skills?.[0]?.name, "watched-skill");
        } finally {
            await ws.dispose();
        }
    });

    // The watcher's blind spot this guards: when a skill dir's whole parent
    // chain is absent (first-run `<cwd>/.taco/skills`), chokidar watches nothing
    // and the first `mkdir -p` + SKILL.md write produces zero events — a silent
    // hot-reload miss for exactly the create-skill flow. The runtime pre-creates
    // the taco-owned leaf to fix this; this test proves a first-time write under
    // an absent parent chain is picked up. See workspace.ts mkdir note.
    it("picks up a SKILL.md created for the first time under an absent parent chain", async () => {
        // Deliberately NOT pre-created: join(tmpDir, ".taco/skills") with no
        // .taco in between — the chain that defeated the bare watcher.
        const freshSkillsDir = join(tmpDirSkillWatch, ".taco", "skills");
        let scanResult: TacoSkill[] = [];
        const ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(tmpDirSkillWatch),
            resources: { skills: [] },
            skillDirs: [freshSkillsDir],
            reloadSkills: async () => ({ skills: scanResult, diagnostics: [] }),
        });

        try {
            await ws.skillWatcherReady;

            const newSkillDir = join(freshSkillsDir, "fresh-skill");
            scanResult = [
                {
                    name: "fresh-skill",
                    description: "created under an absent parent chain",
                    filePath: join(newSkillDir, "SKILL.md"),
                    content: "# fresh-skill",
                    source: "user",
                },
            ];
            // mkdir + write in one burst: the dir now exists (pre-created by the
            // runtime), so this is a post-ready `add` under a watched dir.
            mkdirSync(newSkillDir, { recursive: true });
            writeFileSync(join(newSkillDir, "SKILL.md"), "---\nname: fresh-skill\n---\nbody");

            await waitFor(() => (ws.resources.skills?.length ?? 0) > 0, 2000, 40);
            assert.equal(ws.resources.skills?.[0]?.name, "fresh-skill");
        } finally {
            await ws.dispose();
        }
    });
});

/**
 * WorkspaceRuntime subagent primitives — tests only the parts that don't need a real LLM:
 * findAgent routing, spawnSubagent error with unknown agentType, subagent metadata filtering.
 * Constructible without a provider key, so we can test pure logic directly.
 */

const defs: AgentDefinition[] = [
    {
        agentType: "explorer",
        description: "read-only search",
        systemPrompt: "you explore",
        source: "builtin",
        filePath: "/x/explorer.md",
    },
    {
        agentType: "coder",
        description: "writes code",
        systemPrompt: "you code",
        source: "builtin",
        filePath: "/x/coder.md",
    },
];

describe("WorkspaceRuntime subagent primitives", () => {
    let cwd: string;
    let ws: WorkspaceRuntime;
    let cleanup: () => Promise<void>;

    before(() => {
        ({ ws, cwd, cleanup } = createTestWorkspace({ prefix: "sub", agents: defs }));
    });

    after(() => cleanup());

    /**
     * Create a session, optionally stamping the sidecar's facts on it.
     *
     * `repo.create()` returns an *open* session and 0.85's repo rejects a
     * second open of the same id, so the handle is released before returning.
     */
    async function seedSession(id: string, facts?: SessionFacts): Promise<void> {
        const session = await ws.repo.create({ id, cwd }, harnessContext);
        try {
            if (facts) await writeSessionFacts(session, facts);
        } finally {
            await session.close(harnessContext);
        }
        // openSession resolves through SessionRegistry's metadata cache; a
        // direct repo.create bypasses its invalidation.
        ws.sessionRegistry.invalidateListCache();
    }

    /**
     * Subagent row filter (reader-end contract): keep sessions whose facts say
     * `kind === "subagent"` with a matching parent, then project the fields the
     * agent list surfaces.
     *
     * Reads facts per session rather than a metadata bag — pi 0.85 fixed the
     * metadata shape, so these attributes live in each session's value store
     * and cost one read apiece.
     */
    async function listSubagents(
        ids: readonly string[],
        parentSessionId: string,
    ): Promise<Array<{ sessionId: string; agentType: string; parentToolCallId: string }>> {
        const out: Array<{ sessionId: string; agentType: string; parentToolCallId: string }> = [];
        for (const id of ids) {
            const facts = await ws.getSessionFacts(id as SessionId);
            if (facts.kind !== "subagent" || facts.parentSessionId !== parentSessionId) continue;
            out.push({
                sessionId: id,
                agentType: String(facts.agentType),
                parentToolCallId: String(facts.parentToolCallId),
            });
        }
        return out;
    }

    it("findAgent returns the matching definition, undefined otherwise", () => {
        assert.equal(ws.findAgent("explorer")?.description, "read-only search");
        assert.equal(ws.findAgent("coder")?.agentType, "coder");
        assert.equal(ws.findAgent("nope"), undefined);
    });

    it("spawnSubagent with unknown agentType returns isError without throwing", async () => {
        // Requires a real parent session (spawnSubagent calls openSession for depth).
        // unknown-type branch short-circuits before openSession, so no real parent is needed.
        const res = await ws.spawnSubagent({
            parentSessionId: asSessionId("does-not-matter"),
            parentToolCallId: "tc0",
            agentType: "ghost",
            prompt: "hi",
        });
        assert.equal(res.isError, true);
        assert.match(res.resultText, /unknown agent type: ghost/);
    });

    it("subagent filter returns empty when no children exist", async () => {
        await seedSession("parent-1");
        const subs = await listSubagents(["parent-1"], "parent-1");
        assert.deepEqual(subs, []);
    });

    it("subagent facts persisted at spawn are filtered to the matching parent", async () => {
        // Write facts directly, mirroring what spawnSubagent persists. Validates
        // the reader-side filter + mapping logic (no LLM needed).
        const parentId = "parent-2";
        await seedSession(parentId);
        await seedSession("child-a", {
            kind: "subagent",
            agentType: "explorer",
            parentSessionId: parentId,
            parentToolCallId: "tc1",
            depth: 1,
        });
        await seedSession("child-b", {
            kind: "subagent",
            agentType: "coder",
            parentSessionId: parentId,
            parentToolCallId: "tc2",
            depth: 1,
        });
        // Subagent for a different parent — must not be mixed in
        await seedSession("child-other", {
            kind: "subagent",
            agentType: "explorer",
            parentSessionId: "some-other-parent",
            parentToolCallId: "tcX",
            depth: 1,
        });

        const subs = await listSubagents(
            ["parent-2", "child-a", "child-b", "child-other"],
            parentId,
        );
        assert.equal(subs.length, 2);
        assert.deepEqual(subs.map((s) => s.agentType).sort(), ["coder", "explorer"]);
        assert.deepEqual(subs.map((s) => s.parentToolCallId).sort(), ["tc1", "tc2"]);
    });
});

/**
 * WorkspaceRuntime ↔ commandPermissionRules merge.
 *
 * Guards the wiring in WorkspaceRuntime's permission thunk: rules contributed
 * by extensions must reach the broker's evaluation alongside (not replacing)
 * the user's taco.json rules. Without the merge an officecli command would
 * fall through to "ask"; these tests pin that a contributed rule resolves to
 * "allow" without surfacing a prompt, and that an unrelated rule does not.
 */

describe("WorkspaceRuntime — extension commandPermissionRules reach the broker", () => {
    // Empty TACO_HOME so readGlobalConfig() contributes no user rules — the
    // only rules in play are the ones each test contributes.
    const tmpDirPermRules = useTempTacoHome("permrules");

    const fakeTool = (name: string): TacoTool =>
        ({
            name,
            label: name,
            description: "fake",
            parameters: {},
            async execute() {
                return { content: [{ type: "text", text: "" }], details: {} };
            },
        }) as unknown as TacoTool;

    function extensionsWith(rules: string[]): Readonly<WorkspaceExtensionSet> {
        const set = new WorkspaceExtensionSet();
        set.addContribution("builtin", { commandPermissionRules: rules });
        return Object.freeze(set);
    }

    function makeWorkspace(extensions?: Readonly<WorkspaceExtensionSet>): WorkspaceRuntime {
        return new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            cwd: asWorkspaceId(tmpDirPermRules),
            tools: [fakeTool("noop")],
            extensions,
        });
    }

    it("allows a command matched by an extension rule, without emitting a prompt", async () => {
        const ws = makeWorkspace(extensionsWith(["officecli *"]));
        let requested = false;
        ws.permissionBroker.on("requested", () => {
            requested = true;
        });

        const decision = await ws.permissionBroker.evaluateAndRequest({
            sessionId: "s1",
            toolCallId: "t1",
            command: "officecli view deck.pptx outline",
        });

        assert.equal(decision.approved, true);
        assert.equal(decision.evaluation.behavior, "allow");
        assert.equal(decision.evaluation.source, "rule");
        assert.equal(requested, false, "an allow must not surface a permission prompt");
    });

    it("does not allow the command when only an unrelated rule is contributed", async () => {
        const ws = makeWorkspace(extensionsWith(["mmx *"]));
        // "ask" blocks until the user decides; abort the signal so the broker
        // resolves with a denial and the evaluation can be asserted.
        const decision = await ws.permissionBroker.evaluateAndRequest({
            sessionId: "s1",
            toolCallId: "t1",
            command: "officecli view deck.pptx outline",
            signal: AbortSignal.timeout(50),
        });

        assert.equal(decision.evaluation.behavior, "ask");
        assert.equal(decision.approved, false);
    });
});

/**
 * WorkspaceRuntime's PermissionBroker is wired with a `resolveImPolicy()`
 * thunk, not a constructor-time snapshot of `commands`.
 *
 * Before this fix the broker was constructed with
 * `imCommandPolicy: () => imPolicy?.commands`, where `imPolicy` is the local
 * const captured at line 472 — before `resolveImPolicy` was assigned on line
 * 480. Tool assembly, by contrast, already called `this.resolveImPolicy()`
 * directly, so the two paths disagreed: a hand-edited `commands` block
 * (`mode: ask -> auto`, an `allow` rule) took effect for the next turn's
 * tool list but never for command evaluation on a live IM workspace.
 *
 * The test reads the broker's `imCommandPolicy` thunk via reflection on the
 * WorkspaceRuntime's public `permissionBroker` field, then flips the policy
 * the workspace resolves to and asserts the broker's thunk returns the new
 * `commands` object on the very next call. This is the exact line content
 * that matters: any future engineer closing over `imPolicy` again would
 * fail this assertion.
 */

const ASK_POLICY: ImWorkspacePolicy = {
    tools: { fsTools: "deny", shell: "allow" },
    commands: { mode: "ask" },
    executionDir: { mode: "shared" },
};
const AUTO_ALLOW_LS_POLICY: ImWorkspacePolicy = {
    tools: { fsTools: "deny", shell: "allow" },
    commands: { mode: "auto", allow: ["ls"] },
    executionDir: { mode: "shared" },
};

/** Pull the broker's private `imCommandPolicy` thunk out of a workspace. */
function getBrokerPolicyThunk(ws: WorkspaceRuntime): () => unknown {
    const broker = ws.permissionBroker as unknown as {
        imCommandPolicy?: () => unknown;
    };
    if (!broker.imCommandPolicy) {
        throw new Error(
            "broker has no imCommandPolicy thunk — fix removed or PermissionBroker shape changed",
        );
    }
    return broker.imCommandPolicy;
}

describe("WorkspaceRuntime PermissionBroker im-policy wiring", () => {
    let cwd: string;
    let sessionsRoot: string;
    let ws: WorkspaceRuntime;

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "ws-im-policy-cwd-"));
        sessionsRoot = mkdtempSync(join(tmpdir(), "ws-im-policy-sessions-"));
    });

    afterEach(async () => {
        await ws?.dispose();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(sessionsRoot, { recursive: true, force: true });
    });

    it("the broker's imCommandPolicy thunk reads the current resolveImPolicy(), not a snapshot", () => {
        let policy: ImWorkspacePolicy = ASK_POLICY;
        ws = new WorkspaceRuntime({
            providerKeyStore: new ProviderKeyStore({}),
            scope: createWorkspaceScope(asWorkspaceId("im://mock-2/u1/c1"), cwd),
            sessionsRoot,
            resolveImPolicy: () => policy,
        });

        const thunk = getBrokerPolicyThunk(ws);
        assert.deepEqual(thunk(), ASK_POLICY.commands);

        // The policy is edited in place — e.g. a hand-edited policy file or
        // an admin RPC write — with no reattach and no new WorkspaceRuntime.
        policy = AUTO_ALLOW_LS_POLICY;
        assert.deepEqual(
            thunk(),
            AUTO_ALLOW_LS_POLICY.commands,
            "broker must re-read resolveImPolicy() on every call, not capture it at construction",
        );
    });
});

/**
 * Every attached session converges on a policy change, not just the first to
 * prompt. The change baseline used to be the workspace-level toolset, which the
 * first session's refresh overwrote — so every other session compared equal and
 * kept its pre-change tools and prompt until it was re-attached.
 */
describe("WorkspaceRuntime per-turn toolset refresh across sessions", () => {
    useTempTacoHome();
    stubModelFetch();

    const DENY: ImWorkspacePolicy = {
        tools: { fsTools: "deny", shell: "deny" },
        commands: { mode: "ask" },
        executionDir: { mode: "shared" },
    };
    const ALLOW: ImWorkspacePolicy = { ...DENY, tools: { fsTools: "deny", shell: "allow" } };

    it("a revocation landing during attach is applied on the first turn", async () => {
        // attach assembles the session's tools first and awaits more setup
        // afterwards; a revocation in that window must not be mistaken for
        // the installed state.
        let policy = ALLOW;
        let revokeAfterNextAssembly = false;
        const { ws, cwd, cleanup } = createTestWorkspace({
            prefix: "refresh-attach",
            resolveImPolicy: () => {
                const current = policy;
                if (revokeAfterNextAssembly) {
                    revokeAfterNextAssembly = false;
                    policy = DENY;
                }
                return current;
            },
        });
        try {
            await (await ws.repo.create({ id: "s-a", cwd }, harnessContext)).close(harnessContext);
            ws.invalidateListCache();
            revokeAfterNextAssembly = true;
            const a = await ws.attach(asSessionId("s-a"));
            await a.prompt("hi").catch(() => undefined);
            const active = (await a.toolController?.activeToolNames()) ?? [];
            assert.ok(
                !active.includes("shell"),
                `shell must be revoked, got: ${active.join(", ")}`,
            );
        } finally {
            await cleanup();
        }
    });

    it("a policy grant reaches a second session after the first one refreshed", async () => {
        let policy = DENY;
        const { ws, cwd, cleanup } = createTestWorkspace({
            prefix: "refresh-multi",
            resolveImPolicy: () => policy,
        });
        try {
            for (const id of ["s-a", "s-b"]) {
                await (await ws.repo.create({ id, cwd }, harnessContext)).close(harnessContext);
            }
            ws.invalidateListCache();
            const a = await ws.attach(asSessionId("s-a"));
            const b = await ws.attach(asSessionId("s-b"));
            const activeOf = async (s: typeof a) =>
                (await s.toolController?.activeToolNames()) ?? [];
            assert.ok(!(await activeOf(b)).includes("shell"), "precondition: shell denied");

            policy = ALLOW;
            await a.prompt("hi").catch(() => undefined);
            await b.prompt("hi").catch(() => undefined);

            assert.ok((await activeOf(a)).includes("shell"), "first session must converge");
            assert.ok(
                (await activeOf(b)).includes("shell"),
                `second session must converge too, got: ${(await activeOf(b)).join(", ")}`,
            );
        } finally {
            await cleanup();
        }
    });
});
