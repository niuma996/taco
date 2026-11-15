import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { asSessionId } from "@taco-ai/protocol";
import { createTestWorkspace } from "../_helpers/testWorkspace.ts";

it("four real child runs survive an atomic publication during session directory enumeration", async (t) => {
    const faux = fauxProvider({ tokensPerSecond: 0 });
    const models = createModels();
    models.setProvider(faux.provider);
    let modelCalls = 0;
    faux.setResponses(
        Array.from({ length: 4 }, () => () => {
            modelCalls++;
            return fauxAssistantMessage("inspection complete");
        }),
    );
    const fixture = createTestWorkspace({
        prefix: "concurrent-startup",
        models,
        defaultModel: faux.getModel(),
        compaction: { enabled: false, threshold: 0 },
        agents: [
            {
                agentType: "explorer",
                description: "test",
                systemPrompt: "inspect",
                source: "builtin",
                filePath: "/agents/explorer.md",
            },
        ],
    });
    t.after(() => fixture.cleanup());
    const { ws, cwd } = fixture;
    const parent = asSessionId("parent");
    const meta = await ws.sessionRegistry.createSession(parent, undefined, async () => {});
    const directory = dirname(meta.path);
    const temporary = join(directory, "sibling.jsonl.tmp");
    const destination = join(directory, "sibling.jsonl");
    await fs.writeFile(
        temporary,
        `${JSON.stringify({ v: 4, kind: "header", storageVersion: 1, id: "sibling", cwd, createdAt: Date.now() })}\n`,
    );

    // Hold a real directory snapshot across the rename, without relying on timing.
    const readdir = fs.readdir.bind(fs);
    let renamed = false;
    const listing = t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
        const entries = await readdir(...args);
        if (!renamed && String(args[0]) === directory) {
            renamed = true;
            await fs.rename(temporary, destination);
        }
        return entries;
    });
    syncBuiltinESMExports();
    t.after(() => {
        listing.mock.restore();
        syncBuiltinESMExports();
    });

    const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
            ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: `concurrent-${i}`,
                agentType: "explorer",
                prompt: `inspect area ${i}`,
            }),
        ),
    );
    assert.equal(renamed, true, "the production session filesystem must encounter the race");
    assert.equal(modelCalls, 4);
    assert.equal(new Set(results.map((result) => result.subSessionId)).size, 4);
    for (const result of results) {
        assert.equal(result.isError, false, result.resultText);
        assert.equal(result.resultText, "inspection complete");
        assert.ok(result.subSessionId);
        const history = await ws.sessionRegistry.getHistory(result.subSessionId);
        assert.ok(
            history.entries.some(
                (entry) => entry.type === "message" && entry.message.role === "assistant",
            ),
        );
    }
});
