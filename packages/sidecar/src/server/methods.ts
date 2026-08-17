/**
 * Method registration entry point — wires per-domain handlers together.
 *
 * Registry storage/types live in methodRegistry.ts; per-domain handlers live
 * in handlers/*.ts. This file exposes registerBuiltinMethods(), called once
 * by SidecarServer before startup to fan out to each domain's register*Handlers().
 */

import { registerAgentsHandlers } from "./handlers/agents.ts";
import { registerCatalogHandlers } from "./handlers/catalog.ts";
import { registerChannelsHandlers } from "./handlers/channels.ts";
import { registerCheckpointsHandlers } from "./handlers/checkpoints.ts";
import { registerCommandPermissionHandlers } from "./handlers/commandPermission.ts";
import { registerExtensionsHandlers } from "./handlers/extensions.ts";
import { registerImPolicyHandlers } from "./handlers/imPolicy.ts";
import { registerInitializeHandler } from "./handlers/initialize.ts";
import { registerJobsHandlers } from "./handlers/jobs.ts";
import { registerMcpHandlers } from "./handlers/mcp.ts";
import { registerMemoryHandlers } from "./handlers/memory.ts";
import { registerProviderModelsHandlers } from "./handlers/providerModels.ts";
import { registerSessionLifecycleHandlers } from "./handlers/sessionLifecycle.ts";
import { registerSessionReadHandlers } from "./handlers/sessionRead.ts";
import { registerSessionRuntimeHandlers } from "./handlers/sessionRuntime.ts";
import { registerSessionTurnHandlers } from "./handlers/sessionTurn.ts";
import { registerSettingsHandlers } from "./handlers/settings.ts";
import { registerSkillsHandlers } from "./handlers/skills.ts";
import { registerToolsHandlers } from "./handlers/tools.ts";
import { registerWorkspaceHandlers } from "./handlers/workspace.ts";

/** Builtin method registration entry — called once by SidecarServer before startup */
export function registerBuiltinMethods(): void {
    // Process-level bootstrap must register first so `initialize` is in the
    // registry before any workspace/session method. The dispatch guard still
    // rejects non-`initialize` calls until the handshake completes, but having
    // the method name in `listRegisteredMethods()` is required for the
    // `initialize` response to advertise it.
    registerInitializeHandler();
    registerWorkspaceHandlers();
    registerCommandPermissionHandlers();
    registerSessionLifecycleHandlers();
    registerSessionReadHandlers();
    registerSessionTurnHandlers();
    registerSessionRuntimeHandlers();
    registerCatalogHandlers();
    registerSettingsHandlers();
    registerExtensionsHandlers();
    registerChannelsHandlers();
    registerImPolicyHandlers();
    registerAgentsHandlers();
    registerToolsHandlers();
    registerSkillsHandlers();
    registerMemoryHandlers();
    registerCheckpointsHandlers();
    registerProviderModelsHandlers();
    // PR4: jobs.* lives last so any other handler can reference the
    // scheduler's JobsControl via ServerRpcSurface.jobs without worrying
    // about init order (jobs is process-scoped, never workspace-scoped).
    registerJobsHandlers();
    registerMcpHandlers();
}
