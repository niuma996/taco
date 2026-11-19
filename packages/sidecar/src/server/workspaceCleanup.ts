import { createHash } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
    asSessionId,
    IM_CWD_PREFIX,
    parseImCwd,
    type WorkspaceCleanupResult,
    type WorkspaceId,
} from "@taco-ai/protocol";
import type { ConversationRouter } from "../channels/conversationRouter.ts";
import { chatPolicyKey } from "../channels/imWorkspacePolicy.ts";
import {
    type ImWorkspacePolicyStore,
    imWorkspacePoliciesPath,
} from "../channels/imWorkspacePolicyStore.ts";
import { makeImSessionsRoot } from "../channels/virtualWorkspace.ts";
import { listGitWorktrees, resolveGitProjectRoot } from "../git/gitService.ts";
import { harnessContext } from "../lib/harnessContext.ts";
import { NodeExecutionEnv } from "../runtime/pi/node.ts";
import type { JsonlSessionMetadata } from "../runtime/pi/types.ts";
import { JsonlSessionRepo } from "../runtime/pi/values.ts";
import type { WorkspaceRuntime } from "../runtime/workspace.ts";
import {
    type WorkspaceAssociationStore,
    workspaceAssociationsPath,
} from "../workspace/associationStore.ts";
import { checkpointStoragePaths, memoryProjectDir } from "../workspace/storagePaths.ts";
import { RpcHandlerError } from "./methodRegistry.ts";

type Action = { path: string; execute: () => Promise<void>; validate: () => Promise<void> };
interface CleanupOptions {
    home: string;
    sessionsRoot: string;
    runtimes: () => WorkspaceRuntime[];
    router?: ConversationRouter;
    policy: ImWorkspacePolicyStore;
    associations: WorkspaceAssociationStore;
    hasActiveWork: (cwd: WorkspaceId) => Promise<boolean>;
    dispose: (cwd: WorkspaceId) => Promise<void>;
    beforeSessionDeleted?: (cwd: WorkspaceId, id: string) => Promise<void>;
    onSessionDeleted?: (cwd: WorkspaceId, id: string) => Promise<void>;
}

function hash(key: string, length: number): string {
    return createHash("sha256").update(key).digest("hex").slice(0, length);
}
function inside(root: string, path: string): boolean {
    const rel = relative(resolve(root), resolve(path));
    return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
function safeSegment(value: string): void {
    if (!value || value === "." || value === ".." || /[/\\\0]/.test(value)) {
        throw new RpcHandlerError("invalid_params", "清理路径包含无效标识，未删除任何数据。");
    }
}
async function exists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

/** Reject symlink ancestors; recursive rm unlinks descendant links without following them. */
async function assertOwnedPath(root: string, path: string): Promise<void> {
    if (!inside(root, path)) throw new Error("拒绝删除存储根目录之外的路径。");
    let cursor = parse(resolve(path)).root;
    for (const part of relative(cursor, resolve(path)).split(sep)) {
        cursor = join(cursor, part);
        try {
            const stat = await lstat(cursor);
            // macOS exposes its system temp roots through these OS-owned aliases.
            if (stat.isSymbolicLink() && cursor !== "/var" && cursor !== "/tmp") {
                throw new Error("拒绝删除符号链接或通过符号链接访问的存储路径。");
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
    }
}

/** Builds one bounded plan; previews and execution share ownership and activity checks. */
export class WorkspaceCleanupService {
    constructor(private readonly options: CleanupOptions) {}

    async run(cwd: WorkspaceId, preview: boolean): Promise<WorkspaceCleanupResult> {
        const { home, policy, associations, router } = this.options;
        const route = parseImCwd(cwd);
        if (cwd.startsWith(IM_CWD_PREFIX) && !route)
            throw new RpcHandlerError("invalid_params", "无效的 IM 工作区。");
        if (route) safeSegment(route.channelId);
        const localCwd = resolve(cwd);
        const root = route
            ? makeImSessionsRoot(home, route.channelId)
            : resolve(this.options.sessionsRoot);
        const storageCwd = route ? join(root, "scratch") : localCwd;
        const result: WorkspaceCleanupResult = { removed: [], skipped: [], failed: [] };
        const actions: Action[] = [];
        const protectedPaths = [...(!route ? [localCwd] : []), ...associations.resolve(cwd).roots];
        if (route) {
            const execution = policy.resolve(route).executionDir;
            if (execution.mode === "custom" && execution.path) protectedPaths.push(execution.path);
            const doc = policy.readDocument(route.channelId);
            for (const layer of [doc.default, ...Object.values(doc.chats ?? {})]) {
                if (layer?.executionDir?.mode === "custom" && layer.executionDir.path)
                    protectedPaths.push(layer.executionDir.path);
            }
            for (const runtime of this.options.runtimes()) {
                if (runtime.workspaceKey !== cwd) protectedPaths.push(runtime.executionCwd);
            }
        }
        const retained = (path: string, reason: string) => {
            if (!result.skipped.some((entry) => entry.path === path))
                result.skipped.push({ path, reason });
        };
        const add = async (
            path: string,
            boundary = home,
            execute = () => rm(path, { recursive: true, force: true }),
        ): Promise<void> => {
            if (!(await exists(path))) return;
            try {
                await assertOwnedPath(boundary, path);
                // A custom sessions root may contain the real project or an associated directory.
                if (
                    protectedPaths.some(
                        (keep) =>
                            resolve(path) === resolve(keep) ||
                            inside(path, keep) ||
                            inside(keep, path),
                    )
                ) {
                    retained(path, "保留项目目录及关联目录。");
                    return;
                }
                actions.push({
                    path,
                    validate: () => assertOwnedPath(boundary, path),
                    execute,
                });
            } catch (error) {
                result.failed.push({ path, error: String((error as Error).message) });
            }
        };
        const record = (path: string, execute: () => Promise<void>, file: string) => {
            actions.push({ path, execute, validate: () => assertOwnedPath(home, file) });
        };
        retained(
            route ? storageCwd : localCwd,
            route ? "保留频道共享执行目录。" : "保留项目目录及源文件。",
        );
        for (const path of associations.resolve(cwd).roots)
            retained(path, "仅移除关联记录，保留关联目录及文件。");
        if (route) {
            const execution = policy.resolve(route).executionDir;
            if (execution.mode === "custom" && execution.path)
                retained(execution.path, "保留自定义执行目录及文件。");
        }
        for (const [directory, reason] of [
            ["work", "保留工作记录与结果，仅标记会话已删除。"],
            ["work-queue", "保留已结束的排队工作记录。"],
            ["inbox", "保留消息接收日志。"],
            ["jobs", "保留定时任务配置；启用的任务以后仍可创建工作区会话。"],
        ]) {
            const path = join(home, directory);
            if (await exists(path)) retained(path, reason);
        }
        if (await this.options.hasActiveWork(cwd)) this.busy();

        const repo = new JsonlSessionRepo({
            fileSystem: new NodeExecutionEnv({ cwd: storageCwd }),
            sessionsRoot: root,
        });
        let all: JsonlSessionMetadata[] = [];
        if (await exists(root)) {
            await assertOwnedPath(dirname(root), root);
            all = await repo.list({}, harnessContext);
        }
        const routeSession = route ? router?.lookupByWorkspace(cwd)?.sessionId : undefined;
        const selected = new Map<string, JsonlSessionMetadata>();
        for (const meta of all) {
            if (
                route
                    ? meta.id === routeSession && resolve(meta.cwd) === resolve(storageCwd)
                    : resolve(meta.cwd) === localCwd
            )
                selected.set(meta.id, meta);
        }
        let changed = true;
        while (changed) {
            changed = false;
            for (const meta of all) {
                if (
                    meta.parentSessionId &&
                    selected.has(meta.parentSessionId) &&
                    !selected.has(meta.id)
                ) {
                    selected.set(meta.id, meta);
                    changed = true;
                }
            }
        }
        if (
            route &&
            routeSession &&
            !selected.has(routeSession) &&
            all.some((entry) => entry.id === routeSession)
        ) {
            result.failed.push({
                path: cwd,
                error: "路由会话不存在或存储归属不匹配，已保留路由和会话数据。",
            });
            return result;
        }
        if (
            route &&
            router
                ?.listAll()
                .some(
                    (entry) =>
                        selected.has(entry.sessionId) &&
                        !(
                            entry.channelId === route.channelId &&
                            entry.peerId === route.peerId &&
                            entry.chatId === route.chatId
                        ),
                )
        ) {
            result.failed.push({ path: cwd, error: "会话同时归属于其他路由，拒绝清理。" });
            return result;
        }
        const ordered: JsonlSessionMetadata[] = [];
        const visited = new Set<string>();
        const visiting = new Set<string>();
        const collect = (meta: JsonlSessionMetadata): void => {
            if (visiting.has(meta.id))
                throw new RpcHandlerError("invalid_state", "会话树存在循环，拒绝清理。");
            if (visited.has(meta.id)) return;
            visiting.add(meta.id);
            for (const child of selected.values())
                if (child.parentSessionId === meta.id) collect(child);
            visiting.delete(meta.id);
            visited.add(meta.id);
            ordered.push(meta);
        };
        for (const meta of selected.values()) collect(meta);
        for (const meta of ordered) {
            safeSegment(meta.id);
            if (
                ["im", "scratch", "chats"].includes(meta.id) ||
                meta.id.startsWith("--") ||
                all.some((other) => inside(join(root, meta.id), other.path))
            ) {
                throw new RpcHandlerError(
                    "invalid_params",
                    "辅助目录标识归属不安全，未删除任何数据。",
                );
            }
            if (all.some((entry) => entry.id === meta.id && entry.path !== meta.path)) {
                result.failed.push({
                    path: meta.path,
                    error: "会话文件路径或标识归属不匹配，拒绝清理。",
                });
                continue;
            }
            for (const runtime of this.options.runtimes()) {
                if (resolve(runtime.sessionsRoot) !== root) continue;
                const attached = runtime.getAttached(asSessionId(meta.id));
                if (!attached) continue;
                if ((await attached.getExecutionState()) !== "idle") this.busy();
                const watch = await attached.watchSnapshot();
                try {
                    if (watch.snapshot.queues.length || watch.snapshot.operation) this.busy();
                } finally {
                    watch.unsubscribe();
                }
            }
            // Keep the transcript and its parent route retryable if auxiliary removal fails.
            await add(join(root, meta.id), root);
            await add(meta.path, root, async () => {
                await this.options.beforeSessionDeleted?.(cwd, meta.id);
                await repo.delete(meta, harnessContext);
                await this.options.onSessionDeleted?.(cwd, meta.id);
            });
        }
        await add(join(home, "staging", "attachments", hash(cwd, 32)));
        if (route) {
            await add(memoryProjectDir(cwd, home));
        } else {
            const live = this.options.runtimes().find((runtime) => runtime.workspaceKey === cwd);
            const projectRoot =
                live?.scope.projectRoot ?? (await resolveGitProjectRoot(localCwd)) ?? localCwd;
            const inventory = await listGitWorktrees(localCwd).catch(() => undefined);
            const shared =
                projectRoot !== localCwd ||
                inventory === undefined ||
                (await exists(join(projectRoot, ".taco", "worktrees", "index.json"))) ||
                (inventory?.status === "repository" &&
                    inventory.worktrees.filter((entry) => !entry.bare).length > 1) ||
                this.options
                    .runtimes()
                    .some(
                        (runtime) =>
                            runtime.workspaceKey !== cwd &&
                            runtime.scope?.projectRoot === projectRoot,
                    );
            if (shared)
                retained(
                    memoryProjectDir(projectRoot, home),
                    "保留同一项目的共享记忆；工作树清理不删除项目记忆。",
                );
            else await add(memoryProjectDir(localCwd, home));
        }
        if (!route) await add(checkpointStoragePaths(storageCwd, home).root);
        if (route) {
            const chatScratch = join(root, "chats", chatPolicyKey(route), "scratch");
            await add(chatScratch, root);
            await add(checkpointStoragePaths(chatScratch, home).root);
            if (routeSession)
                record(
                    `${join(home, "sessions", "im", "routing.json")}#${cwd}`,
                    async () => {
                        if (!(await router?.remove(cwd, routeSession)))
                            throw new Error("路由已变化，未移除路由记录。");
                    },
                    join(home, "sessions", "im", "routing.json"),
                );
            if (policy.readDocument(route.channelId).chats?.[chatPolicyKey(route)])
                record(
                    `${imWorkspacePoliciesPath(route.channelId, home)}#chats/${chatPolicyKey(route)}`,
                    () => policy.clearChatOverride(route),
                    imWorkspacePoliciesPath(route.channelId, home),
                );
        }
        const own = { scope: "workspace" as const, id: cwd };
        if (associations.get(own).length)
            record(
                `${workspaceAssociationsPath(home)}#workspaces/${route ? cwd : localCwd}`,
                async () => {
                    await associations.set(own, []);
                },
                workspaceAssociationsPath(home),
            );

        // Validate every operation before the first mutation, and repeat each path check at use.
        for (const action of actions) {
            try {
                await action.validate();
            } catch (error) {
                result.failed.push({ path: action.path, error: (error as Error).message });
            }
        }
        if (preview) {
            result.removed = result.failed.length ? [] : actions.map((action) => action.path);
            return result;
        }
        if (result.failed.length) return result;
        if (await this.options.hasActiveWork(cwd)) this.busy();
        try {
            await this.options.dispose(cwd);
        } catch (error) {
            result.failed.push({ path: cwd, error: (error as Error).message });
            return result;
        }
        for (const action of actions) {
            try {
                await action.validate();
                await action.execute();
                result.removed.push(action.path);
            } catch (error) {
                result.failed.push({ path: action.path, error: (error as Error).message });
                for (const pending of actions.slice(actions.indexOf(action) + 1))
                    retained(pending.path, "前置清理失败，保留以便重试。");
                break;
            }
        }
        return result;
    }

    private busy(): never {
        throw new RpcHandlerError(
            "invalid_state",
            "工作区仍有活动会话或排队任务，请等待结束后再清理。",
        );
    }
}
