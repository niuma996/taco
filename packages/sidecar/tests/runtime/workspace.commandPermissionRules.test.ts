/**
 * WorkspaceRuntime ↔ commandPermissionRules merge.
 *
 * Guards the wiring in WorkspaceRuntime's permission thunk: rules contributed
 * by extensions must reach the broker's evaluation alongside (not replacing)
 * the user's taco.json rules. Without the merge an officecli command would
 * fall through to "ask"; these tests pin that a contributed rule resolves to
 * "allow" without surfacing a prompt, and that an unrelated rule does not.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { WorkspaceExtensionSet } from "../../src/extensions/activation.ts";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import type { TacoTool } from "../../src/tools/index.ts";

let tmpDir: string;
let prevTacoHome: string | undefined;

before(() => {
    prevTacoHome = process.env.TACO_HOME;
    tmpDir = mkdtempSync(join(tmpdir(), "taco-ws-permrules-"));
    // Empty TACO_HOME so readGlobalConfig() contributes no user rules — the
    // only rules in play are the ones each test contributes.
    process.env.TACO_HOME = tmpDir;
});

after(() => {
    if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
    else process.env.TACO_HOME = prevTacoHome;
    rmSync(tmpDir, { recursive: true, force: true });
});

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
        cwd: tmpDir,
        tools: [fakeTool("noop")],
        extensions,
    });
}

describe("WorkspaceRuntime — extension commandPermissionRules reach the broker", () => {
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
