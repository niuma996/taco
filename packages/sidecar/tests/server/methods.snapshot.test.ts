/**
 * Registry snapshot — asserts that registerBuiltinMethods() produces the
 * full set of known methods with the expected metadata. Pure file moves
 * MUST NOT change this; intentional metadata changes (add, remove, rename,
 * alter ensureWorkspace / command / turnStart) MUST update this explicitly.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/methods.snapshot.test.ts
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

import { getRegisteredMethod } from "../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../src/server/methods.ts";

interface MethodMeta {
    ensureWorkspace: boolean;
    command?: boolean;
    turnStart?: boolean;
    workspaceParam?: "workspace" | "cwd";
}

function snapshotMethod(name: string): MethodMeta | null {
    const reg = getRegisteredMethod(name);
    if (!reg) return null;
    return {
        ensureWorkspace: reg.ensureWorkspace,
        command: reg.options.command ?? undefined,
        turnStart: reg.options.turnStart ?? undefined,
        workspaceParam: reg.options.workspaceParam ?? undefined,
    };
}

function snapshotAll(names: string[]): Record<string, MethodMeta> {
    const out: Record<string, MethodMeta> = {};
    for (const name of [...names].sort()) {
        const meta = snapshotMethod(name);
        assert.ok(meta !== null, `method not registered: ${name}`);
        out[name] = meta;
    }
    return out;
}

const EXPECTED_METHODS: Record<string, MethodMeta> = {
    "agents.content": { ensureWorkspace: true },
    "agents.list": { ensureWorkspace: true },
    "channels.bind": { ensureWorkspace: false, command: true },
    "channels.create": { ensureWorkspace: false, command: true },
    "channels.list": { ensureWorkspace: false },
    "channels.submitVerifyCode": { ensureWorkspace: false, command: true },
    "channels.unbind": { ensureWorkspace: false, command: true },
    "command_permission.resolve": { ensureWorkspace: true, command: true },
    "extensions.status": { ensureWorkspace: false },
    "memory.deleteTopic": { ensureWorkspace: true },
    "memory.list": { ensureWorkspace: true },
    "memory.upsert": { ensureWorkspace: true },
    "memory.write": { ensureWorkspace: true },
    "provider.listModels": { ensureWorkspace: false },
    "providers.list": { ensureWorkspace: true },
    "session.abort": { ensureWorkspace: true, command: true },
    "session.attach": { ensureWorkspace: true, command: true },
    "session.compact": { ensureWorkspace: true, command: true },
    "session.contextInfo": { ensureWorkspace: true },
    "session.create": { ensureWorkspace: true, command: true },
    "session.delete": { ensureWorkspace: true, command: true },
    "session.detach": { ensureWorkspace: true, command: true },
    "session.events.get": { ensureWorkspace: true },
    "session.history": { ensureWorkspace: true },
    "session.list": { ensureWorkspace: true },
    "session.listModels": { ensureWorkspace: true },
    "session.planState.get": { ensureWorkspace: true },
    "session.prompt": { ensureWorkspace: true, command: true, turnStart: true },
    "session.rename": { ensureWorkspace: true, command: true },
    "session.setModel": { ensureWorkspace: true, command: true },
    "session.setThinkingLevel": { ensureWorkspace: true, command: true },
    "session.snapshot.get": { ensureWorkspace: true },
    "session.steer": { ensureWorkspace: true, command: true },
    "session.submitAnswers": { ensureWorkspace: true, command: true, turnStart: true },
    "session.taskHistory.get": { ensureWorkspace: true },
    "session.tasks.get": { ensureWorkspace: true },
    "settings.get": { ensureWorkspace: false },
    "settings.write": { ensureWorkspace: false },
    "skills.content": { ensureWorkspace: true },
    "skills.list": { ensureWorkspace: true },
    "tools.list": { ensureWorkspace: true },
    "workspace.dispose": { ensureWorkspace: false, command: true, workspaceParam: "cwd" },
    "workspace.ensure": { ensureWorkspace: false, command: true, workspaceParam: "cwd" },
    "workspace.list": { ensureWorkspace: false },
};

before(() => {
    registerBuiltinMethods();
});

describe("registry snapshot", () => {
    it("total method count matches expected", () => {
        const actualNames = Object.keys(snapshotAll(Object.keys(EXPECTED_METHODS)));
        assert.equal(
            actualNames.length,
            Object.keys(EXPECTED_METHODS).length,
            "registered method count changed — update EXPECTED_METHODS",
        );
    });

    for (const [name, expectedMeta] of Object.entries(EXPECTED_METHODS)) {
        it(`method ${name}: ensureWorkspace=${expectedMeta.ensureWorkspace}${expectedMeta.command ? ", command" : ""}${expectedMeta.turnStart ? ", turnStart" : ""}${expectedMeta.workspaceParam ? `, workspaceParam=${expectedMeta.workspaceParam}` : ""}`, () => {
            const actual = snapshotMethod(name);
            assert.ok(
                actual !== null,
                `expected ${name} to be registered but getRegisteredMethod returned undefined`,
            );
            // Compare only the keys the expected entry declares — handlers may
            // add new metadata fields over time, and the snapshot should stay
            // compact (only cares about the fields it asserts).
            const subset: Record<string, unknown> = {};
            for (const key of Object.keys(expectedMeta)) {
                subset[key] = (actual as unknown as Record<string, unknown>)[key];
            }
            assert.deepEqual(subset, expectedMeta, `${name} metadata mismatch`);
        });
    }

    it("no extra methods are registered beyond the snapshot", () => {
        // Collect all registered names, excluding internal/private ones.
        // Each handler file registers public names only, so the snapshot
        // should be exhaustive.
        const snapshotNames = new Set(Object.keys(EXPECTED_METHODS));
        const unknown: string[] = [];
        for (const candidate of [
            // session handlers
            "session.list",
            "session.create",
            "session.attach",
            "session.detach",
            "session.delete",
            "session.history",
            "session.snapshot.get",
            "session.tasks.get",
            "session.planState.get",
            "session.taskHistory.get",
            "session.prompt",
            "session.steer",
            "session.submitAnswers",
            "session.abort",
            "session.setModel",
            "session.listModels",
            "session.setThinkingLevel",
            "session.compact",
            "session.contextInfo",
            "session.rename",
            "session.events.get",
            // non-session mixed into session.ts
            "command_permission.resolve",
            "providers.list",
            // settings
            "settings.get",
            "settings.write",
            // workspace
            "workspace.list",
            "workspace.ensure",
            "workspace.dispose",
            // extensions
            "extensions.status",
            // channels
            "channels.list",
            "channels.create",
            "channels.bind",
            "channels.submitVerifyCode",
            "channels.unbind",
            // agents
            "agents.list",
            "agents.content",
            // tools
            "tools.list",
            // skills
            "skills.list",
            "skills.content",
            // memory
            "memory.list",
            "memory.write",
            "memory.deleteTopic",
            "memory.upsert",
            // provider
            "provider.listModels",
        ]) {
            if (!snapshotNames.has(candidate)) {
                const reg = getRegisteredMethod(candidate);
                if (reg) unknown.push(candidate);
            }
        }
        assert.deepEqual(
            unknown,
            [],
            "extra methods registered but not in EXPECTED_METHODS — update the snapshot",
        );
    });
});
