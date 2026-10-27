/** Compile-only checks for payload, result, and routing inference. */
import { asWorkspaceId, type CreateSessionResult, RPC } from "@taco-ai/protocol";
import type { RpcDispatch } from "../contractDispatch.js";
import { createContractDispatch } from "../contractDispatch.js";

async function checkDispatch(raw: RpcDispatch) {
    const dispatch = createContractDispatch(raw);
    const workspace = asWorkspaceId("/w");
    const result: CreateSessionResult = await dispatch.call(RPC.sessionCreate, workspace, {
        workspace,
    });
    // @ts-expect-error session.create requires workspace in its payload
    await dispatch.call(RPC.sessionCreate, workspace, {});
    // @ts-expect-error settings.get is process-scoped
    await dispatch.call(RPC.settingsGet, workspace, {});
    // @ts-expect-error session.create is workspace-scoped
    await dispatch.callProcess(RPC.sessionCreate, { workspace });
    // @ts-expect-error method determines the result type
    const wrong: string = await dispatch.call(RPC.sessionCreate, workspace, { workspace });
    await dispatch.callProcess(RPC.settingsGet, undefined);
    await dispatch.callProcess(RPC.channelsList, undefined);
    // @ts-expect-error jobs.get requires params
    await dispatch.callProcess(RPC.jobsGet, undefined);
    // @ts-expect-error required process params cannot be omitted
    await dispatch.callProcess(RPC.channelsBind, undefined);
    // @ts-expect-error mcp create requires transport in config
    await dispatch.callProcess(RPC.mcpCreateConfig, { config: { id: "srv" } });
    // @ts-expect-error memory.write is workspace-scoped
    await dispatch.callProcess(RPC.memoryWrite, { workspace, content: "", baseHash: "" });
    // @ts-expect-error memory.write requires the concurrency hash
    await dispatch.call(RPC.memoryWrite, workspace, { workspace, content: "" });
    void [result, wrong];
}
void checkDispatch;
