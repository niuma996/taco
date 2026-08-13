/**
 * Round-trip regression: `saveGlobalConfig` must persist every field on
 * TacoGlobalConfigShape, then `readGlobalConfig` must return it.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/config/config.roundTrip.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { TacoGlobalConfigShape } from "@taco-ai/protocol";
import { readGlobalConfig, saveGlobalConfig } from "../../src/config/config.ts";

describe("saveGlobalConfig round-trip", () => {
    let tmpDir: string;
    let prevTacoHome: string | undefined;

    before(() => {
        prevTacoHome = process.env.TACO_HOME;
        tmpDir = mkdtempSync(join(tmpdir(), "taco-config-roundtrip-"));
        process.env.TACO_HOME = tmpDir;
    });

    after(() => {
        if (prevTacoHome === undefined) {
            Reflect.deleteProperty(process.env, "TACO_HOME");
        } else {
            process.env.TACO_HOME = prevTacoHome;
        }
        rmSync(tmpDir, { recursive: true, force: true });
    });

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
            value: { mode: "auto", rules: ["pnpm test"] },
        },
        { name: "extensions", value: ["@taco/ext-a", "@taco/ext-b"] },
        { name: "disabledExtensions", value: ["@taco/ext-b"] },
    ];

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
