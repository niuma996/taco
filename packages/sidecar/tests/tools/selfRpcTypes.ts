import type { SettingsGetResult } from "@taco-ai/protocol";
import { asWorkspaceId, RPC } from "@taco-ai/protocol";
import type { SelfRpcCall } from "../../src/tools/context.ts";

/** Compile-only regression cases for the tool context's wire-name API. */
async function checkSelfRpc(call: SelfRpcCall) {
    const workspace = asWorkspaceId("/w");
    const result: SettingsGetResult = await call(RPC.settingsGet, workspace, {});
    // @ts-expect-error params are inferred from the method, not the caller
    await call(RPC.sessionCreate, workspace, {});
    // @ts-expect-error result is inferred from the method
    const wrongResult: string = await call(RPC.settingsGet, workspace, {});
    // @ts-expect-error unknown method
    await call("settings.missing", workspace, {});
    void [result, wrongResult];
}
void checkSelfRpc;
