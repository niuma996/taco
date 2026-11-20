/** Server-side session-preserving handoff; no public RPC or mutable workspace cwd. */
import {
    asSessionId,
    asWorkspaceId,
    type WorktreeBase,
    type WorktreeHandoffParams,
} from "@taco-ai/protocol";
import { stageFromPath } from "../attachments/attachmentStore.ts";
import { composeForSession } from "../attachments/composePrompt.ts";
import { uuidv7 } from "../runtime/pi/values.ts";
import type { WorkspaceRuntime } from "../runtime/workspace.ts";
import { tagWrap } from "../tags/builder.ts";
import type { WorktreeStartRequest } from "../worktree/handoff.ts";

interface HandoffOptions {
    ensureWorkspace(cwd: ReturnType<typeof asWorkspaceId>): Promise<WorkspaceRuntime>;
    create(
        cwd: string,
        name: string,
        base?: WorktreeBase,
    ): Promise<{ path: string; branch: string }>;
    run<T>(cwd: string, operation: () => Promise<T>): Promise<T>;
    emit(params: WorktreeHandoffParams): void;
}

export function createWorktreeHandoff(options: HandoffOptions) {
    return async (request: WorktreeStartRequest): Promise<WorktreeHandoffParams> => {
        const source = await options.ensureWorkspace(request.sourceWorkspace);
        const sourceSession = source.getAttached(request.sourceSessionId);
        if (source.scope.kind !== "local" || sourceSession?.sessionKind !== "main")
            throw new Error("Worktree handoff requires an attached local main session");
        const created = await options.create(request.sourceWorkspace, request.name, request.base);
        return await options.run(created.path, async () => {
            const target = await options.ensureWorkspace(asWorkspaceId(created.path));
            const sessionId = asSessionId(uuidv7());
            const handoff: WorktreeHandoffParams = {
                sourceWorkspace: request.sourceWorkspace,
                sourceSessionId: request.sourceSessionId,
                workspace: asWorkspaceId(created.path),
                sessionId,
                path: created.path,
                branch: created.branch,
            };

            try {
                await target.createSession(sessionId);
                const title = request.task.slice(0, 60).replace(/\n+/g, " ").trim();
                if (title)
                    await target.setPlaceholderTitle(sessionId, title).catch(() => undefined);
                const staged: string[] = [];
                for (const attachment of request.attachments ?? []) {
                    const copy = await stageFromPath(target.workspaceKey, attachment.path);
                    staged.push(copy.id);
                }
                const attached = await target.attach(sessionId, {
                    model: (await sourceSession.getModel()) ?? undefined,
                    thinkingLevel: sourceSession.getThinkingLevel(),
                });
                const turn = await composeForSession(
                    target,
                    attached,
                    sessionId,
                    `${tagWrap(
                        "worktree_handoff",
                        "This session is already the managed worktree created for the user's request. Execute the underlying task in this checkout. The original request for isolation is satisfied; do not create another worktree unless the user explicitly asks for an additional separate one.",
                    )}\n\n${request.task}`,
                    request.images,
                    staged,
                );
                options.emit(handoff);
                await attached.prompt(
                    turn.text,
                    turn.images,
                    sourceSession.getUiLocale(),
                    request.signal,
                );
            } catch (error) {
                throw new Error(
                    `Worktree handoff retained ${created.path} and session ${sessionId}: ${String(error)}`,
                    { cause: error },
                );
            } finally {
                target.invalidateListCache();
            }
            return handoff;
        });
    };
}
