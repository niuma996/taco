/**
 * `buildSkillReinjector` reads the current `store.skills` array through a
 * live getter, not a constructor-time snapshot.
 *
 * `hookWiring.ts` used to call `buildSkillReinjector({ skills: opts.skills })`
 * with the workspace's frozen `this.skills` reference captured at the time
 * `wireHarnessHooks` ran. When `SessionRegistry.updateSkills()` later
 * swapped `this.skills` for a fresh array (e.g. on a `reloadSkillsNow()` call
 * or a follow-up pipeline), the already-installed reinjector kept restoring
 * bodies from the pre-reload list — sessions that invoked the new skill saw
 * nothing, and sessions that invoked a removed skill kept getting its body
 * even after the workspace's hot-reload log had acknowledged its death.
 *
 * The fix passes `buildSkillReinjector({ get skills() { return getSkills(); } })`
 * — a getter the hook re-evaluates on every invocation. This test confirms
 * the invariant directly: mark a skill, swap the underlying list, run the
 * hook with no messages in context, and assert the reinjected body comes
 * from the new list.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSkillReinjector, type SkillStore } from "../../src/skills/skillReinjector.ts";

interface MinimalSkill {
    name: string;
    content: string;
}

const skillV1: MinimalSkill = { name: "echo", content: "echo v1 body" };
const skillV2: MinimalSkill = { name: "echo", content: "echo v2 body — replaced after reload" };

describe("buildSkillReinjector store getter", () => {
    it("re-reads store.skills on every invocation, not a constructor-time snapshot", () => {
        // The store's `skills` field is a getter — `hookWiring.ts` builds
        // exactly this shape via `{ get skills() { return getSkills(); } }`,
        // so the hook sees whatever list the workspace resolves on each call.
        let current: readonly MinimalSkill[] = [skillV1];
        const store: SkillStore = {
            get skills() {
                return current;
            },
        } as SkillStore & { readonly skills: readonly MinimalSkill[] };

        const { hook, handle } = buildSkillReinjector(store);
        handle.markInvoked("echo");

        // Empty message list — no `<skill_body:echo>` in context, so the
        // reinjector tries to splice a body back in. With v1 in the store,
        // it should restore the v1 body.
        const before = hook({ messages: [] });
        const beforeBodies = before.messages.map((m) =>
            String((m as { content: unknown }).content),
        );
        assert.ok(
            beforeBodies.some((b) => b.includes("echo v1 body")),
            `hook with v1 in store must reinject v1 body, got: ${JSON.stringify(beforeBodies)}`,
        );

        // Hot-reload — the workspace swaps its skills array for a new list
        // (same name, different body). The hook must re-read store.skills.
        current = [skillV2];

        const after = hook({ messages: [] });
        const afterBodies = after.messages.map((m) => String((m as { content: unknown }).content));
        assert.ok(
            afterBodies.some((b) => b.includes("echo v2 body")),
            `hook after reload must reinject v2 body, not the v1 snapshot, got: ${JSON.stringify(afterBodies)}`,
        );
        assert.ok(
            !afterBodies.some((b) => b.includes("echo v1 body")),
            "stale v1 body must not appear after the store swapped lists",
        );
    });
});
