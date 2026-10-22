/** Consolidated from 4 test files; behaviour unchanged. */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadAgents } from "../../src/agents/loadAgents.ts";
import type { ImWorkspacePolicy } from "../../src/channels/imWorkspacePolicy.ts";
import { defaultSkillDirs, saveGlobalConfig } from "../../src/config/config.ts";
import { tacoHome } from "../../src/config/tacoHome.ts";
import { ExtensionRegistry } from "../../src/extensions/registry.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { SlashNormalizedExecutionEnv } from "../../src/runtime/harness/slashNormalizedEnv.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { loadSourcedSkills } from "../../src/runtime/pi/values.ts";
import { resolveImExecutionCwd } from "../../src/server/imExecutionCwd.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { dedupeSkillsByName } from "../../src/skills/dedupeSkills.ts";
import type { TacoSkill } from "../../src/skills/tacoSkill.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

describe("server.agents", () => {
    /**
     * verify that loadAgents — called from the production-style path —
     * finds the builtin agents under src/agents/builtin.
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/server.agents.test.ts
     */

    describe("server.ts agent loading path", () => {
        it("loads the builtin agents from src/agents/builtin", async () => {
            const builtinDir = join(import.meta.dirname, "..", "..", "src", "agents", "builtin");
            // userDirs: [] — intentionally skips host ~/.claude / ~/.pi / ~/.taco/agents
            // to avoid host-fs drift on dev machines contaminating the builtin assertions.
            const agents = await loadAgents({ builtinDir, userDirs: [] });
            const types = agents.map((a) => a.agentType).sort();
            assert.deepEqual(types, ["explorer", "reviewer", "verification"]);
        });
    });
});

describe("server.skillsDedupe", () => {
    /**
     * Verifies the server skill-loading path: loadSourcedSkills(defaultSkillDirs) →
     * dedupeSkillsByName actually dedupes same-named skills with project
     * <cwd>/.taco/skills winning (first-wins dedup, project source is first,
     * builtin is last as fallback).
     *
     * Builds the composed pipeline directly rather than spinning up a full
     * SidecarServer. Uses TACO_HOME (not the real ~/.claude) as the "loses"
     * source so the test stays hermetic.
     */

    function writeSkill(dir: string, name: string, description: string): void {
        const skillDir = join(dir, name);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
            join(skillDir, "SKILL.md"),
            `---\nname: ${name}\ndescription: ${description}\n---\n\n${name} body\n`,
        );
    }

    async function loadDeduped(cwd: string): Promise<TacoSkill[]> {
        // Mirror server.ts: it loads skills through SlashNormalizedExecutionEnv so
        // pi-agent-core's relativeEnvPath sees forward-slash paths on Windows. Using
        // the same env keeps this test on the production path (a raw NodeExecutionEnv
        // reproduces the "path.relative()'d string" throw that the wrapper fixes).
        const skillEnv = new SlashNormalizedExecutionEnv({ cwd });
        const loaded = await loadSourcedSkills<TacoSkill["source"], TacoSkill>(
            skillEnv,
            defaultSkillDirs(cwd),
            (skill, source): TacoSkill => ({ ...skill, source }),
            harnessContext,
        );
        return dedupeSkillsByName(loaded.skills.map((entry) => entry.skill));
    }

    describe("server.ts skill-loading path: loadSourcedSkills + dedupeSkillsByName", () => {
        const tmpHome = useTempTacoHome("server-skills-home");
        let tmpCwd: string;
        let tmpUserHome: string;
        let prevHome: string | undefined;

        before(() => {
            prevHome = process.env.HOME;
            tmpCwd = mkdtempSync(join(tmpdir(), "taco-server-skills-cwd-"));
            // Isolate $HOME: defaultSkillDirs reads ~/.claude/skills and ~/.pi/skills
            // via os.homedir(), so a developer's personal skill sharing a name with
            // one of these fixtures (or a builtin) would change the scan under test.
            tmpUserHome = mkdtempSync(join(tmpdir(), "taco-server-skills-userhome-"));
            process.env.HOME = tmpUserHome;

            // $TACO_HOME/skills/foo — global taco source (lower priority than project)
            writeSkill(join(tmpHome, "skills"), "foo", "foo from taco global");
            // <cwd>/.taco/skills/foo — project source, highest priority per
            // defaultSkillDirs order, same name as the global one above
            writeSkill(join(tmpCwd, ".taco", "skills"), "foo", "foo from project taco");
            // a uniquely-named skill so we can confirm non-duplicates survive
            writeSkill(join(tmpCwd, ".taco", "skills"), "bar", "bar unique");
        });

        after(() => {
            if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME");
            else process.env.HOME = prevHome;
            rmSync(tmpCwd, { recursive: true, force: true });
            rmSync(tmpUserHome, { recursive: true, force: true });
        });

        it("dedupes same-named skill across sources, project <cwd>/.taco wins by first-wins order", async () => {
            const deduped = await loadDeduped(tmpCwd);

            const fooSkills = deduped.filter((s) => s.name === "foo");
            assert.equal(fooSkills.length, 1, "only one 'foo' skill should remain after dedupe");
            assert.equal(
                fooSkills[0].description,
                "foo from project taco",
                "<cwd>/.taco/skills is first in defaultSkillDirs, so it wins over $TACO_HOME/skills",
            );
            assert.equal(fooSkills[0].source, "user");

            const barSkills = deduped.filter((s) => s.name === "bar");
            assert.equal(barSkills.length, 1, "unique skill 'bar' is untouched by dedupe");
            assert.equal(barSkills[0].source, "user");
        });

        it("loads the real builtin skills directory and tags entries source: builtin", async () => {
            const deduped = await loadDeduped(tmpCwd);
            const builtinSkills = deduped.filter((s) => s.source === "builtin");
            // Asserts the directory is wired and readable, without naming a
            // specific skill — the builtin set changes as skills are added and
            // renamed, and pinning a name makes this test fail for the wrong reason.
            assert.ok(
                builtinSkills.length > 0,
                `expected at least one skill from skills/builtin/, got ${builtinSkills.length}`,
            );
        });

        it("lets a user-provided skill override a builtin skill of the same name", async () => {
            // Shadow whichever builtin actually exists rather than a hard-coded
            // name: a name that matches no builtin would make this pass while
            // testing nothing (there would be no duplicate to resolve).
            const builtinName = (await loadDeduped(tmpCwd)).find(
                (s) => s.source === "builtin",
            )?.name;
            assert.ok(builtinName, "need at least one builtin skill to shadow");

            // <cwd>/.taco/skills is the first array entry = highest priority, so
            // first-wins dedup should keep the user version over the builtin.
            writeSkill(join(tmpCwd, ".taco", "skills"), builtinName, "user override");
            const deduped = await loadDeduped(tmpCwd);
            const matches = deduped.filter((s) => s.name === builtinName);
            assert.equal(matches.length, 1);
            assert.equal(matches[0].source, "user");
            assert.equal(matches[0].description, "user override");
        });
    });
});

describe("imExecutionCwd", () => {
    const ROUTE = { channelId: "wechat", peerId: "u1", chatId: "c1" };
    const DEFAULT_POLICY: ImWorkspacePolicy = {
        tools: { fsTools: "deny", shell: "deny" },
        commands: { mode: "ask" },
        executionDir: { mode: "shared" },
    };

    describe("resolveImExecutionCwd", () => {
        it("default policy returns the channel scratch and marks it shared", () => {
            const home = mkdtempSync(join(tmpdir(), "im-exec-"));
            const out = resolveImExecutionCwd({
                sessionsRoot: join(home, "sessions", "im", "wechat"),
                route: ROUTE,
                policy: DEFAULT_POLICY,
            });
            assert.equal(out.shared, true);
            assert.ok(out.executionCwd.endsWith(`${join("wechat", "scratch")}`));
            assert.equal(out.warning, undefined);
        });

        it("per-chat mode isolates to a per-chat dir and creates it", () => {
            const home = mkdtempSync(join(tmpdir(), "im-exec-"));
            const out = resolveImExecutionCwd({
                sessionsRoot: join(home, "sessions", "im", "wechat"),
                route: ROUTE,
                policy: { ...DEFAULT_POLICY, executionDir: { mode: "per-chat" } },
            });
            assert.equal(out.shared, false);
            assert.ok(out.executionCwd.includes("chats"));
            assert.ok(out.executionCwd.endsWith("scratch"));
            // Directory is created eagerly so tools can write immediately.
            assert.ok(existsSync(out.executionCwd));
        });

        it("a custom directory is used as-is", () => {
            const home = mkdtempSync(join(tmpdir(), "im-exec-"));
            const bound = mkdtempSync(join(tmpdir(), "im-bound-"));
            const out = resolveImExecutionCwd({
                sessionsRoot: join(home, "sessions", "im", "wechat"),
                route: ROUTE,
                policy: {
                    ...DEFAULT_POLICY,
                    executionDir: { mode: "custom", path: bound },
                },
            });
            assert.equal(out.executionCwd, bound);
            assert.equal(out.shared, false);
        });

        it("a custom directory pointing at a file falls back to the shared scratch with a warning", () => {
            const home = mkdtempSync(join(tmpdir(), "im-exec-"));
            const file = join(home, "not-a-dir");
            writeFileSync(file, "x");
            const out = resolveImExecutionCwd({
                sessionsRoot: join(home, "sessions", "im", "wechat"),
                route: ROUTE,
                policy: { ...DEFAULT_POLICY, executionDir: { mode: "custom", path: file } },
            });
            assert.equal(out.shared, true);
            assert.ok(out.warning);
            assert.ok(out.warning.includes(file));
        });

        it("a custom directory pointing at a nonexistent path falls back with a warning", () => {
            const home = mkdtempSync(join(tmpdir(), "im-exec-"));
            const missing = join(home, "no", "such", "dir");
            const out = resolveImExecutionCwd({
                sessionsRoot: join(home, "sessions", "im", "wechat"),
                route: ROUTE,
                policy: { ...DEFAULT_POLICY, executionDir: { mode: "custom", path: missing } },
            });
            assert.equal(out.shared, true);
            assert.ok(out.warning);
        });
    });
});

describe("imPolicyGlobalRules", () => {
    useTempTacoHome("im-policy-global-rules");

    function serverWithExtensionRule(rule: string): SidecarServer {
        const extensionRegistry = new ExtensionRegistry();
        extensionRegistry.addWorkspaceActivator("builtin", "@taco/test-ext", () => ({
            commandPermissionRules: [rule],
        }));
        return new SidecarServer({ providerKeyStore: new ProviderKeyStore({}), extensionRegistry });
    }

    describe("imPolicy.get global rule group", () => {
        it("includes extension allow-rules the runtime broker appends", async () => {
            saveGlobalConfig({
                commandPermissions: { mode: "ask", allow: ["ls"], deny: ["rm *"] },
            });
            const result = await serverWithExtensionRule("officecli *").imPolicy.get({
                channelId: "wechat",
            });
            assert.deepEqual(result.rules.allow[0], {
                source: "global",
                rules: ["ls", "officecli *"],
                editable: false,
            });
            assert.deepEqual(result.rules.deny[0], {
                source: "global",
                rules: ["rm *"],
                editable: false,
            });
        });

        it("still loads the editor when taco.json commandPermissions is malformed", async () => {
            writeFileSync(
                join(tacoHome(), "taco.json"),
                JSON.stringify({ commandPermissions: { allow: "not-an-array" } }),
            );
            // A no-op save drops the in-process config cache so the hand edit is read.
            saveGlobalConfig({});
            const result = await serverWithExtensionRule("officecli *").imPolicy.get({
                channelId: "wechat",
            });
            assert.deepEqual(result.rules.allow[0]?.rules, ["officecli *"]);
            assert.deepEqual(result.rules.deny, [{ source: "channel", rules: [], editable: true }]);
        });
    });
});
