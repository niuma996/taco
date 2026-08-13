/**
 * workspace.* handler — workspace lifecycle (list / ensure / dispose).
 */

import {
    workspaceDisposeSchema,
    workspaceEnsureSchema,
    workspaceListSchema,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { registerMethod } from "../methodRegistry.ts";

export function registerWorkspaceHandlers(): void {
    registerMethod(
        RPC.workspaceList,
        false,
        async ({ server }) => {
            return [...server.workspaceIds()];
        },
        { schema: workspaceListSchema },
    );

    registerMethod(
        RPC.workspaceEnsure,
        false,
        async ({ cwd, server }) => {
            await server.ensureWorkspace(cwd);
            return { cwd };
        },
        { workspaceParam: "cwd", command: true, schema: workspaceEnsureSchema },
    );

    registerMethod(
        RPC.workspaceDispose,
        false,
        async ({ cwd, server }) => {
            await server.disposeWorkspace(cwd);
            return null;
        },
        { workspaceParam: "cwd", command: true, schema: workspaceDisposeSchema },
    );
}
