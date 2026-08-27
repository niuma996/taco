import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { PermissionBroker } from "../../src/permissions/permissionBroker.ts";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { createShellTool } from "../../src/tools/shellTool.ts";

const ASK_CONFIG = { mode: "ask" as const, rules: [] };

function context(cwd: string) {
    return { env: new NodeExecutionEnv({ cwd }) };
}

type ShellToolResult = {
    content: Array<{ type?: string; text?: string }>;
    details: {
        exitCode: number;
        interrupted: boolean;
        reason?: "permission_denied" | "permission_timeout" | "permission_aborted";
    };
    isError: boolean;
};

function textOf(result: ShellToolResult): string {
    const first = result.content[0];
    if (first?.type !== "text") throw new Error("expected text content");
    return first.text ?? "";
}

describe("shellTool permission results", () => {
    it("returns an explicit failed result when the user denies approval", async () => {
        const broker = new PermissionBroker(() => ASK_CONFIG);
        const tool = createShellTool({ permissionBroker: broker, sessionId: "session-1" });
        const requestId = new Promise<string>((resolve) => {
            broker.once("requested", (request) => resolve(request.requestId));
        });
        const pending = tool.execute(
            "tool-call-1",
            { command: "echo approved-only-after-user-action" },
            undefined,
            undefined,
            context("/tmp"),
        );
        broker.resolve(await requestId, false, "once");
        const result = (await pending) as ShellToolResult;

        assert.equal(result.isError, true);
        assert.equal(result.details.reason, "permission_denied");
        assert.equal(result.details.exitCode, -1);
        assert.match(textOf(result), /user explicitly denied/);
        assert.match(textOf(result), /Do not retry/);
    });

    it("returns a timeout-specific failed result when approval expires", async () => {
        const broker = new PermissionBroker(() => ASK_CONFIG, { requestTimeoutMs: 5 });
        const tool = createShellTool({ permissionBroker: broker, sessionId: "session-1" });
        const result = (await tool.execute(
            "tool-call-1",
            { command: "echo should-not-run" },
            undefined,
            undefined,
            context("/tmp"),
        )) as ShellToolResult;

        assert.equal(result.isError, true);
        assert.equal(result.details.reason, "permission_timeout");
        assert.match(textOf(result), /permission request timed out/);
        assert.match(textOf(result), /Do not retry automatically/);
    });

    it("returns an aborted failed result when the turn is cancelled", async () => {
        const broker = new PermissionBroker(() => ASK_CONFIG);
        const tool = createShellTool({ permissionBroker: broker, sessionId: "session-1" });
        const controller = new AbortController();
        const pending = tool.execute(
            "tool-call-1",
            { command: "echo should-not-run" },
            controller.signal,
            undefined,
            context("/tmp"),
        );
        controller.abort();
        const result = (await pending) as ShellToolResult;

        assert.equal(result.isError, true);
        assert.equal(result.details.reason, "permission_aborted");
        assert.match(textOf(result), /current turn was cancelled/);
        assert.match(textOf(result), /Do not retry automatically/);
    });

    it("maps a policy denial (no denialReason) to permission_denied", async () => {
        // A read-only broker degrades "ask" to an immediate deny without ever
        // reaching the UI, so the decision carries no denialReason. That is a
        // known path, not an unrecognised one — see deniedResult.
        const broker = new PermissionBroker(() => ASK_CONFIG, { readOnly: true });
        const tool = createShellTool({ permissionBroker: broker, sessionId: "session-1" });
        const result = (await tool.execute(
            "tool-call-1",
            { command: "rm -rf /tmp/nope" },
            undefined,
            undefined,
            context("/tmp"),
        )) as ShellToolResult;

        assert.equal(result.isError, true);
        assert.equal(result.details.reason, "permission_denied");
        assert.equal(result.details.exitCode, -1);
    });

    it("propagates isError from shell execution failures", async () => {
        const tool = createShellTool();
        const result = (await tool.execute(
            "tool-call-1",
            { command: "exit 7" },
            undefined,
            undefined,
            context("/tmp"),
        )) as ShellToolResult;

        assert.equal(result.isError, true);
        assert.equal(result.details.exitCode, 7);
        assert.equal(result.details.reason, undefined);
    });
});

describe("shell tool env scrubbing", () => {
    afterEach(() => {
        for (const k of Object.keys(process.env)) {
            if (k.endsWith("_API_KEY")) delete process.env[k];
        }
    });

    it("does not expose injected provider keys to executed commands", {
        skip: process.platform === "win32",
    }, async () => {
        // Constructing the store mirrors the key into process.env (for pi)
        // and records it as injected so shell.ts can scrub it.
        const store = new ProviderKeyStore({ anthropic: "sk-ant-secret-1234567890" });
        assert.equal(store.has("anthropic"), true);
        assert.equal(process.env.ANTHROPIC_API_KEY, "sk-ant-secret-1234567890");

        const tool = createShellTool();
        const result = (await tool.execute(
            "tool-call-1",
            { command: "env" },
            undefined,
            undefined,
            context("/tmp"),
        )) as ShellToolResult;

        assert.equal(textOf(result).includes("sk-ant-secret-1234567890"), false);
    });
});
