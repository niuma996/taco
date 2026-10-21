/**
 * The config tools' boundary and wiring.
 *
 * Two things matter here: that a local main session can read and change the
 * config, and that nobody else can. The approval itself is the broker's
 * job — see permissionBroker.config.test.ts.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import { createConfigTools, patchFields } from "../../src/tools/config.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";
import { sessionToolContext } from "../_helpers/toolContext.ts";

function makeCtx(calls: { method: string; params: unknown }[] = []) {
    return sessionToolContext({
        call: async <P, R>(method: string, _workspace: string, params: P): Promise<R> => {
            calls.push({ method, params: params as unknown });
            if (method === "settings.get") {
                return {
                    global: {
                        defaultModel: "claude-opus-5",
                        anthropicApiKey: { configured: true },
                    },
                } as R;
            }
            return { approved: true, fields: [], global: { defaultModel: "claude-opus-5" } } as R;
        },
    });
}

describe("config tools", () => {
    describe("configGet", () => {
        it("returns the masked config through settings.get", async () => {
            const calls: { method: string; params: unknown }[] = [];
            const { configGet } = createConfigTools();
            const result = await invokeTool(configGet, {}, makeCtx(calls));
            assert.equal(calls[0]?.method, "settings.get");
            const text = (result.content[0] as { text: string }).text;
            // The masked view is what comes back — a configured key shows as
            // present, never as its value.
            assert.match(text, /defaultModel/);
        });

        it("refuses an IM session", async () => {
            const { configGet } = createConfigTools();
            const ctx = sessionToolContext({ isIm: true });
            await assert.rejects(
                () => invokeTool(configGet, {}, ctx),
                /not available in this session/,
            );
        });

        it("refuses a subagent", async () => {
            const { configGet } = createConfigTools();
            const ctx = sessionToolContext({ sessionKind: "subagent" });
            await assert.rejects(
                () => invokeTool(configGet, {}, ctx),
                /not available in this session/,
            );
        });
    });

    describe("configPatch", () => {
        it("routes the change through config.patch so the server can approve it", async () => {
            const calls: { method: string; params: unknown }[] = [];
            const { configPatch } = createConfigTools();
            await invokeTool(
                configPatch,
                { patch: { defaultModel: "claude-opus-5" } },
                makeCtx(calls),
            );
            assert.equal(calls[0]?.method, "config.patch");
            const params = calls[0]?.params as {
                workspace: string;
                sessionId: string;
                toolCallId: string;
                patch: Record<string, unknown>;
            };
            // The approval prompt needs the session and the tool call to land
            // on the right card.
            assert.equal(params.sessionId, asSessionId("test-session"));
            assert.equal(params.toolCallId, "tc-1");
            assert.deepEqual(params.patch, { defaultModel: "claude-opus-5" });
        });

        it("reports a declined change without writing", async () => {
            const calls: { method: string; params: unknown }[] = [];
            const { configPatch } = createConfigTools();
            const ctx = sessionToolContext({
                call: async <P, R>(method: string, _workspace: string, params: P): Promise<R> => {
                    calls.push({ method, params: params as unknown });
                    return { approved: false, fields: ["defaultModel"] } as R;
                },
            });
            const result = await invokeTool(
                configPatch,
                { patch: { defaultModel: "claude-opus-5" } },
                ctx,
            );
            const text = (result.content[0] as { text: string }).text;
            assert.match(text, /declined/);
            assert.equal((result.details as { approved: boolean }).approved, false);
        });

        it("refuses an IM session", async () => {
            const { configPatch } = createConfigTools();
            const ctx = sessionToolContext({ isIm: true });
            await assert.rejects(
                () => invokeTool(configPatch, { patch: { defaultModel: "x" } }, ctx),
                /not available in this session/,
            );
        });

        it("refuses a subagent", async () => {
            const { configPatch } = createConfigTools();
            const ctx = sessionToolContext({ sessionKind: "subagent" });
            await assert.rejects(
                () => invokeTool(configPatch, { patch: { defaultModel: "x" } }, ctx),
                /not available in this session/,
            );
        });
    });

    describe("patchFields", () => {
        it("lists only the fields the patch sets", () => {
            assert.deepEqual(
                patchFields({ defaultModel: "x", thinkingLevel: undefined } as never),
                ["defaultModel"],
            );
        });
    });
});
