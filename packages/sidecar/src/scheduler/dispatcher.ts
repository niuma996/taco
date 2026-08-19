/**
 * dispatcher.ts — routes scheduled job fires to the SidecarServer RPC layer.
 *
 * The scheduler fires callbacks without a live workspace context, so the
 * command cannot go through the normal `MethodCtx` / workspace-coupled
 * handler registry. Instead, this module talks directly to
 * `SidecarServer.dispatchRpc`.
 *
 * Session strategy governs how a fire maps onto a session id:
 *   - `new` (default): every fire creates a fresh `sched-<uuid>` session
 *     via `session.create({ initialPrompt })` — creating + running in one
 *     wire call avoids any create→prompt race window if the scheduler
 *     dies between them.
 *   - `reuse`: IM only — looks up the existing session bound to the job's
 *     (channelId, peerId, chatId) triple and re-prompts it via
 *     `session.attach + session.prompt`. Lets a scheduled task continue
 *     an ongoing chat conversation; if no route exists the fire errors
 *     (we don't silently fall back to `new` — that would split the user's
 *     conversation across two sessions).
 *   - `pin`: first fire creates `sched-pin-<jobId>` and `onPinnedSessionCreated`
 *     writes the id back to the job; subsequent fires probe that session and
 *     attach it. If the pinned session is gone (manual delete, wiped
 *     sessions dir) the fire re-creates and re-pins instead of erroring:
 *     losing the accumulated conversation context is bad, but the
 *     alternative was worse — attach on a missing session raises an opaque
 *     `[upstream]` error and nothing cleared the dangling id, so the job
 *     stayed wedged on every subsequent tick until edited by hand.
 */

import { randomUUID } from "node:crypto";
import { parseImCwd, type RpcRequest, type RpcResponse } from "@taco-ai/protocol";

import { createLogger } from "../lib/logger.ts";
import type { Job, SessionStrategy } from "./types.ts";

const log = createLogger("sidecar.scheduler.dispatcher");

/** Minimal surface the dispatcher needs from SidecarServer. Kept narrow
 *  so tests can stub it without dragging in the full ServerRpcSurface. */
interface DispatchSurface {
    dispatchRpc(req: RpcRequest): Promise<RpcResponse>;
    /** Bind a session to its (channel, peer, chat) triple so the channel's
     *  reply router can address outbound messages. Required after the
     *  pin strategy creates a session via `session.create` directly —
     *  that path bypasses `conversationRouter.route()` and would otherwise
     *  leave the session unrouteable. No-op for non-IM workspaces. */
    registerRoute?(workspace: string, sessionId: string): Promise<void>;
}

/** Resolve the runtime server a job's invoke should dispatch to, based on
 *  the workspace the job targets. In daemon mode the resolver picks the
 *  IM host for `im://` workspaces and a separate fs runtime for the rest
 *  — keeping the channel stack and IM workspaces on the resident rather
 *  than re-implementing them per-invocation. See `runDaemon`. */
export type ServerResolver = (workspace: string) => DispatchSurface;

export class UnsupportedScheduledCommand extends Error {
    constructor(command: string) {
        super(`unsupported scheduled command: ${command}`);
        this.name = "UnsupportedScheduledCommand";
    }
}

export class ScheduledCommandFailed extends Error {
    constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "ScheduledCommandFailed";
    }
}

/** Thrown when a job's `sessionStrategy` cannot be honored for its workspace
 *  (e.g. `reuse` on an fs workspace, where there's no "existing session"
 *  concept). Surfaces as a per-run `status=err` entry. */
export class InvalidSessionStrategy extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidSessionStrategy";
    }
}

export type JobCommandInvoker = (job: Job) => Promise<void>;

/** Callback the dispatcher invokes after creating the pinned session on a
 *  `pin` strategy's first fire, so the scheduler can persist `pinnedSessionId`
 *  back to the job. */
export type OnPinnedSessionCreated = (jobId: string, sessionId: string) => Promise<void>;

export interface DispatcherOptions {
    /** Persist `pinnedSessionId` after the first fire of a `pin` job. */
    onPinnedSessionCreated?: OnPinnedSessionCreated;
}

export function createJobDispatcher(
    resolveServer: ServerResolver,
    options: DispatcherOptions = {},
): JobCommandInvoker {
    return async (job) => {
        const workspace = typeof job.args.workspace === "string" ? job.args.workspace : "*";
        const server = resolveServer(workspace);
        switch (job.command) {
            case "agent.invoke":
                await invokeAgent(server, job, workspace, options.onPinnedSessionCreated);
                return;
            default:
                throw new UnsupportedScheduledCommand(job.command);
        }
    };
}

async function invokeAgent(
    server: DispatchSurface,
    job: Job,
    workspace: string,
    onPinnedSessionCreated?: OnPinnedSessionCreated,
): Promise<void> {
    const prompt = String(job.args.prompt ?? "");
    if (!prompt) {
        throw new Error("agent.invoke requires args.prompt");
    }
    const strategy = resolveStrategy(job.sessionStrategy, workspace);

    switch (strategy) {
        case "new": {
            const id = `sched-${randomUUID()}`;
            const res = await server.dispatchRpc({
                id,
                method: "session.create",
                params: { workspace, sessionId: id, initialPrompt: prompt },
            });
            if (!res.ok) throw new ScheduledCommandFailed(res.error.code, res.error.message);
            return;
        }
        case "reuse": {
            const existing = await lookupSession(server, workspace);
            if (!existing) {
                throw new InvalidSessionStrategy(
                    `reuse strategy: no session bound to ${workspace}`,
                );
            }
            await attachAndPrompt(server, workspace, existing, prompt);
            return;
        }
        case "pin": {
            const pinned = job.pinnedSessionId;
            // A pinned id can outlive its session: manual deletion, a
            // cleanup script, or a wiped sessions dir. Probe before
            // attaching — `session.attach` on a missing session surfaces an
            // opaque `[upstream] Cannot read properties of undefined` rather
            // than a clean not_found, and the old code let that repeat on
            // every fire forever with no path back to a working state.
            // Falling through to the create branch re-pins a fresh session
            // instead, so the job self-heals on its next tick.
            if (pinned && (await sessionExists(server, workspace, pinned))) {
                // Register before prompting: the reverse index is in-memory
                // only, so after a daemon restart the attach path is the
                // only thing that can rebuild it. Skipping it here means
                // every fire after a restart drops its replies.
                await registerRouteBestEffort(server, workspace, pinned);
                await attachAndPrompt(server, workspace, pinned, prompt);
                return;
            }
            if (pinned) {
                log.warn(
                    `pinned session ${pinned} for job ${job.id} no longer exists; re-creating`,
                );
            }
            const id = `sched-pin-${job.id}`;
            const im = isImWorkspace(workspace) ? parseImCwd(workspace) : undefined;
            // imRouting is stored in the session file header and read by
            // rebuildFromJsonl to seed the forward route map. We use
            // "scheduler" as the channelId so rebuildFromJsonl seeds the pin
            // session under a different routes key than the peer's live
            // conversation (im://scheduler/... vs im://wechat/...). The peer's
            // peerId and chatId are preserved so findRouteBySessionId still
            // resolves the correct destination for the agent's replies.
            const imRouting = im
                ? { channelId: "scheduler", peerId: im.peerId, chatId: im.chatId }
                : undefined;
            const res = await server.dispatchRpc({
                id,
                method: "session.create",
                params: {
                    workspace,
                    sessionId: id,
                    initialPrompt: prompt,
                    ...(imRouting ? { imRouting } : {}),
                },
            });
            if (!res.ok) throw new ScheduledCommandFailed(res.error.code, res.error.message);
            await registerRouteBestEffort(server, workspace, id);
            if (onPinnedSessionCreated) {
                await onPinnedSessionCreated(job.id, id);
            }
            return;
        }
    }
}

/** Resolve the strategy the dispatcher will actually apply.
 *  `reuse` requires an `im://` workspace (fs has no "this peer" concept) —
 *  explicit `reuse` on fs is a hard error so a corrupt job file surfaces
 *  immediately rather than silently falling back to a different behavior.
 *  Unknown stored values coerce to the safe default `new`. */
function resolveStrategy(raw: SessionStrategy | undefined, workspace: string): SessionStrategy {
    if (!raw || raw === "new") return "new";
    if (raw === "reuse") {
        if (!isImWorkspace(workspace)) {
            throw new InvalidSessionStrategy(
                `reuse strategy requires im:// workspace (got ${workspace})`,
            );
        }
        return "reuse";
    }
    if (raw === "pin") return "pin";
    return "new";
}

function isImWorkspace(workspace: string): boolean {
    return workspace.startsWith("im://");
}

/** Probe whether a session is still on disk, via `session.history` (the same
 *  check ConversationRouter uses — `session.list` filters subagents out and
 *  would report a live session as missing).
 *
 *  Returns false on any failure. That biases toward re-creating a session
 *  that actually exists, which `JsonlSessionRepo` tolerates poorly (create
 *  does not overwrite, it writes a second parallel file). The alternative
 *  bias is worse: treating a transport hiccup as "exists" sends us into the
 *  attach path against a session that isn't there, which is the opaque
 *  `[upstream]` crash this probe exists to avoid. */
async function sessionExists(
    server: DispatchSurface,
    workspace: string,
    sessionId: string,
): Promise<boolean> {
    try {
        const res = await server.dispatchRpc({
            id: randomUUID(),
            method: "session.history",
            params: { workspace, sessionId },
        });
        return res.ok === true;
    } catch (err) {
        log.warn(
            `session.history probe failed for ${sessionId}, treating as absent: ${String(err)}`,
        );
        return false;
    }
}

/** Bind a scheduler-owned session to its IM triple so channel replies can
 *  address the peer. Never throws: the session already exists (and may
 *  already be mid-turn), so a routing-index failure is worth a warning but
 *  not worth failing the fire and losing the agent's work. The symptom of a
 *  miss is a dropped reply, which the channel logs on its own. */
async function registerRouteBestEffort(
    server: DispatchSurface,
    workspace: string,
    sessionId: string,
): Promise<void> {
    if (!server.registerRoute) return;
    try {
        await server.registerRoute(workspace, sessionId);
    } catch (err) {
        log.warn(`failed to register route for ${sessionId} on ${workspace}: ${String(err)}`);
    }
}

/** Find the sessionId bound to an IM workspace via the routing table.
 *  `session.list` returns every session under the workspace; we pick the
 *  most recently updated one matching the routing entry. Returns undefined
 *  when nothing is routed yet — the caller decides whether to fall back,
 *  error, or create (currently `reuse` errors; `pin` with no id creates). */
async function lookupSession(
    server: DispatchSurface,
    workspace: string,
): Promise<string | undefined> {
    const res = await server.dispatchRpc({
        id: randomUUID(),
        method: "session.list",
        params: { workspace },
    });
    if (!res.ok) return undefined;
    const sessions = ((res.result as { sessions?: unknown }).sessions ?? []) as Array<{
        sessionId?: string;
    }>;
    const first = sessions.find((s) => typeof s.sessionId === "string")?.sessionId;
    return first;
}

async function attachAndPrompt(
    server: DispatchSurface,
    workspace: string,
    sessionId: string,
    prompt: string,
): Promise<void> {
    const attach = await server.dispatchRpc({
        id: randomUUID(),
        method: "session.attach",
        params: { workspace, sessionId },
    });
    if (!attach.ok) throw new ScheduledCommandFailed(attach.error.code, attach.error.message);
    const promptRes = await server.dispatchRpc({
        id: randomUUID(),
        method: "session.prompt",
        params: { workspace, sessionId, text: prompt },
    });
    if (!promptRes.ok) {
        throw new ScheduledCommandFailed(promptRes.error.code, promptRes.error.message);
    }
}
