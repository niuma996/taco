/**
 * Round-trip regression: `saveGlobalConfig` must persist every field on
 * TacoGlobalConfigShape, then `readGlobalConfig` must return it.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/config/config.roundTrip.test.ts
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { GlobalConfigPatch, TacoGlobalConfigShape } from "@taco-ai/protocol";
import { readGlobalConfig, saveGlobalConfig } from "../../src/config/config.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

describe("saveGlobalConfig round-trip", () => {
    useTempTacoHome("config-roundtrip");

    // Covers every scalar field. A fresh file must round-trip the written value.
    // Note: theme / debugMode have been removed from TacoGlobalConfigShape; they are not
    // part of the sidecar protocol.
    const scalars: ReadonlyArray<{
        readonly name: keyof TacoGlobalConfigShape;
        readonly value: unknown;
    }> = [
        { name: "defaultModel", value: "anthropic/claude-sonnet" },
        { name: "defaultProvider", value: "anthropic" },
        { name: "sessionsRoot", value: "/tmp/sessions" },
        { name: "systemPrompt", value: "be terse" },
        { name: "thinkingLevel", value: "medium" },
        { name: "anthropicApiKey", value: "sk-ant-test" },
        { name: "openaiApiKey", value: "sk-openai-test" },
        {
            name: "commandPermissions",
            value: { mode: "auto", allow: ["pnpm test"], deny: [] },
        },
        { name: "extensions", value: ["@taco/ext-a", "@taco/ext-b"] },
        { name: "disabledExtensions", value: ["@taco/ext-b"] },
    ];

    const clearable: ReadonlySet<keyof TacoGlobalConfigShape> = new Set([
        "defaultModel",
        "defaultProvider",
        "sessionsRoot",
        "systemPrompt",
        "thinkingLevel",
        "anthropicApiKey",
        "openaiApiKey",
    ]);

    for (const { name, value } of scalars) {
        it(`persists scalar field ${String(name)}`, () => {
            saveGlobalConfig({ [name]: value } as Partial<TacoGlobalConfigShape>);
            const after = readGlobalConfig();
            assert.deepEqual(
                after[name],
                value,
                `saveGlobalConfig dropped the field "${String(name)}" — add it to the patch handler`,
            );
        });
    }

    // A clear arrives as `null` (undefined keys vanish in JSON.stringify) and
    // must be stored as an absent key, not a persisted `null`.
    for (const { name, value } of scalars.filter((s) => clearable.has(s.name))) {
        it(`clears scalar field ${String(name)} on null`, () => {
            saveGlobalConfig({ [name]: value } as GlobalConfigPatch);
            saveGlobalConfig({ [name]: null } as GlobalConfigPatch);
            const after = readGlobalConfig();
            assert.equal(after[name], undefined);
            assert.ok(!(name in after), `"${String(name)}" persisted as a key after a null clear`);
        });
    }

    it("apiKeys is shallow-merged, not replaced", () => {
        saveGlobalConfig({ apiKeys: { a: "1", b: "2" } });
        saveGlobalConfig({ apiKeys: { b: "3", c: "4" } });
        assert.deepEqual(readGlobalConfig().apiKeys, { a: "1", b: "3", c: "4" });
    });

    it("compaction is shallow-merged, not replaced", () => {
        // Write enabled=true / threshold=0.5, then patch threshold=0.6 alone — enabled must be preserved.
        saveGlobalConfig({ compaction: { enabled: true, threshold: 0.5 } });
        saveGlobalConfig({ compaction: { threshold: 0.6 } });
        const after = readGlobalConfig();
        assert.deepEqual(after.compaction, { enabled: true, threshold: 0.6 });
    });
});
