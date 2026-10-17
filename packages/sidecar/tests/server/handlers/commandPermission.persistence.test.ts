import assert from "node:assert/strict";
import { before, it } from "node:test";
import { readGlobalConfig, saveGlobalConfig } from "../../../src/config/config.ts";
import { PermissionBroker } from "../../../src/permissions/permissionBroker.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

useTempTacoHome("permission-persistence");
before(registerBuiltinMethods);
it("ignores forged persistent approval for unsupported syntax", async () => {
    saveGlobalConfig({ commandPermissions: { mode: "auto", allow: [], deny: [] } });
    const broker = new PermissionBroker(
        () => readGlobalConfig().commandPermissions ?? { mode: "ask", allow: [], deny: [] },
    );
    const requested = new Promise<string>((resolve) =>
        broker.once("requested", (request) => resolve(request.requestId)),
    );
    const pending = broker.evaluateAndRequest({
        sessionId: "s1",
        toolCallId: "t1",
        command: "echo $(pwd)",
    });
    await callMethod("commandPermission.resolve", {
        workspace: { permissionBroker: broker },
        params: { requestId: await requested, approved: true, scope: "global" },
    });
    assert.equal((await pending).scope, "once");
    assert.deepEqual(readGlobalConfig().commandPermissions?.allow, []);
});
it("persists a static path approval without replacing newer rules", async () => {
    saveGlobalConfig({ commandPermissions: { mode: "ask", allow: [], deny: [] } });
    const broker = new PermissionBroker(
        () => readGlobalConfig().commandPermissions ?? { mode: "ask", allow: [], deny: [] },
    );
    const requested = new Promise<string>((resolve) =>
        broker.once("requested", (request) => resolve(request.requestId)),
    );
    const command = "./gradlew build -x test";
    const pending = broker.evaluateAndRequest({ sessionId: "s1", toolCallId: "t1", command });
    const requestId = await requested;
    saveGlobalConfig({
        commandPermissionsEdit: { addAllow: ["pnpm test"], addDeny: ["git push *"] },
    });
    await callMethod("commandPermission.resolve", {
        workspace: { permissionBroker: broker },
        params: { requestId, approved: true, scope: "global" },
    });
    assert.equal((await pending).approved, true);
    assert.deepEqual(readGlobalConfig().commandPermissions?.allow, ["pnpm test", command]);
    assert.deepEqual(readGlobalConfig().commandPermissions?.deny, ["git push *"]);
    assert.equal(
        (await broker.evaluateAndRequest({ sessionId: "s1", toolCallId: "t2", command })).approved,
        true,
    );
});
