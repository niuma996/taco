/** Public DTOs must retain the exact schema and method-map types. */
import type {
    GitInitParams,
    GitInspectParams,
    GitWorktreeInfo,
    PushParams,
    RpcMethodParams,
    RpcMethodResult,
    WorktreeBase,
    WorktreeChangedParams,
    WorktreeCleanupParams,
    WorktreeCleanupResult,
    WorktreeCreateParams,
    WorktreeHandoffParams,
    WorktreeListParams,
    WorktreeRemoveParams,
} from "../src/index.js";

type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type GitContractChecks = [
    Assert<Equal<GitInspectParams, RpcMethodParams<"git.inspect">>>,
    Assert<Equal<GitInitParams, RpcMethodParams<"git.init">>>,
    Assert<Equal<WorktreeListParams, RpcMethodParams<"worktree.list">>>,
    Assert<Equal<WorktreeCreateParams, RpcMethodParams<"worktree.create">>>,
    Assert<Equal<WorktreeRemoveParams, RpcMethodParams<"worktree.remove">>>,
    Assert<Equal<WorktreeCleanupParams, RpcMethodParams<"worktree.cleanup">>>,
    Assert<Equal<WorktreeCleanupResult, RpcMethodResult<"worktree.cleanup">>>,
    Assert<Equal<WorktreeBase, NonNullable<WorktreeCreateParams["base"]>>>,
    Assert<Equal<GitWorktreeInfo["managed"], boolean | undefined>>,
    Assert<Equal<GitWorktreeInfo["orphaned"], boolean | undefined>>,
    Assert<
        Equal<
            WorktreeChangedParams,
            {
                projectRoot: string;
                path: string;
                kind: "created" | "removed";
            }
        >
    >,
    Assert<Equal<PushParams<"worktree.changed">, WorktreeChangedParams>>,
    Assert<Equal<PushParams<"worktree.handoff">, WorktreeHandoffParams>>,
    Assert<
        Equal<
            WorktreeHandoffParams,
            {
                sourceWorkspace: import("../src/index.js").WorkspaceId;
                sourceSessionId: import("../src/index.js").SessionId;
                workspace: import("../src/index.js").WorkspaceId;
                sessionId: import("../src/index.js").SessionId;
                path: string;
                branch: string;
            }
        >
    >,
];
