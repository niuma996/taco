import { resolve } from "node:path";
import {
    asWorkspaceId,
    IM_CWD_PREFIX,
    type ImRoute,
    parseImCwd,
    type WorkspaceId,
} from "@taco-ai/protocol";

type WorkspacePaths = {
    readonly key: WorkspaceId;
    /** Storage partition, preserved when the execution policy changes. */
    readonly sessionCwd: WorkspaceId;
    readonly executionCwd: WorkspaceId;
};

export type WorkspaceScope = WorkspacePaths &
    ({ readonly kind: "local" } | { readonly kind: "im"; readonly route: Readonly<ImRoute> });

/** Resolve filesystem paths while preserving the public routing key. IM keys require explicit storage. */
export function createWorkspaceScope(
    key: WorkspaceId,
    sessionCwd: string = key,
    executionCwd: string = sessionCwd,
): WorkspaceScope {
    const route = parseImCwd(key);
    if (key.startsWith(IM_CWD_PREFIX) && !route)
        throw new Error(`invalid IM workspace key: ${key}`);
    if (sessionCwd.startsWith(IM_CWD_PREFIX) || executionCwd.startsWith(IM_CWD_PREFIX)) {
        throw new Error("IM workspace scope requires filesystem storage and execution directories");
    }
    const paths = {
        key,
        sessionCwd: asWorkspaceId(resolve(sessionCwd)),
        executionCwd: asWorkspaceId(resolve(executionCwd)),
    };
    return route ? { ...paths, kind: "im", route } : { ...paths, kind: "local" };
}
