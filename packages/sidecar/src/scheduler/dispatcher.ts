import { resolveWaitingInteraction } from "../runtime/session/waitingInteraction.ts";
/**
 * dispatcher.ts — routes scheduled job fires to the SidecarServer RPC layer.
 *
 * The scheduler fires callbacks without a live workspace context, so this
 * module calls `SidecarServer.dispatchRpc` directly instead of the `MethodCtx`
 * handler registry.
 *
 * Session strategy governs how a fire maps onto a session id:
 *   - `new`: creates a `sched-<uuid>` session and prompts it in one wire call,
 *     so no create→prompt race.
 *   - `reuse`: IM only — re-prompts the job's bound session; no route is an
 *     error, never a fall back to `new`.
 *   - `pin`: the first fire writes `sched-pin-<jobId>` back to the job; a lost
 *     id is re-created and re-pinned.
 */

import { randomUUID } from "node:crypto";
import {
    asSessionId,
    asWorkspaceId,
    createRpcRequest,
    ErrorCodes,
    RPC,
    type RpcRequest,
    type RpcResponse,
} from "@taco-ai/protocol";

import { createLogger } from "../lib/logger.ts";
import { textFromAgentMessage } from "../runtime/harness/messageText.ts";
import type { QueuedOutcome, QueuedWatch } from "../runtime/harness/queuedWatch.ts";
import type { AgentMessage } from "../runtime/pi/types.ts";
import type { ScheduledFireSettle, ScheduledWorkHooks } from "../work/workHooks.ts";
import { isBuiltinJob } from "./builtinJobs.ts";
import type { FireContext, InvokeResult } from "./runner.ts";
import type { Job, SessionStrategy } from "./types.ts";

const log = createLogger("sidecar.scheduler.dispatcher");

/** Minimal surface the dispatcher needs from SidecarServer. Kept narrow
 *  so tests can stub it without dragging in the full ServerRpcSurface. */
interface DispatchSurface {
    dispatchRpc(req: RpcRequest): Promise<RpcResponse>;
    lookupRoute?(workspace: string): { sessionId: string } | undefined;
    /** Buffer queue events before prompting; absent on test stubs. */
    queueWatch?(workspace: string, sessionId: string): QueuedWatch | undefined;
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

export type JobCommandInvoker = (job: Job, fire?: FireContext) => Promise<InvokeResult | undefined>;

/** Native handler for a built-in job command (see builtinJobs.ts). */
export type BuiltinJobHandler = (job: Job) => Promise<InvokeResult>;

/** Callback the dispatcher invokes after creating the pinned session on a
 *  `pin` strategy's first fire, so the scheduler can persist `pinnedSessionId`
 *  back to the job. */
export type OnPinnedSessionCreated = (
    jobId: string,
    sessionId: string,
    /** The generation the fire was scheduled under; a stale write is ignored. */
    generation: string | undefined,
) => Promise<void>;

export interface DispatcherOptions {
    /** Persist `pinnedSessionId` after the first fire of a `pin` job. */
    onPinnedSessionCreated?: OnPinnedSessionCreated;
    /** Handlers for built-in job commands, keyed by command. Only a job with
     *  `builtin: true` may reach one — a user job naming the same command is
     *  rejected, never routed. */
    builtinHandlers?: ReadonlyMap<string, BuiltinJobHandler>;
    /** Tracks each agent turn as a Work. Absent in tests that only check routing. */
    work?: ScheduledWorkHooks;
}

/** What one agent fire reports back to the runner. */
export interface AgentInvokeResult extends InvokeResult {
    workId?: string;
}

export function createJobDispatcher(
    resolveServer: ServerResolver,
    options: DispatcherOptions = {},
): JobCommandInvoker {
    return async (job, fire) => {
        // Built-ins run in-process and target no workspace; checked first so a
        // built-in never reaches the agent path.
        if (isBuiltinJob(job)) {
            const handler = options.builtinHandlers?.get(job.command);
            if (!handler) throw new UnsupportedScheduledCommand(job.command);
            return handler(job);
        }
        const workspace = typeof job.args.workspace === "string" ? job.args.workspace : "*";
        const server = resolveServer(workspace);
        switch (job.command) {
            case "agent.invoke":
                return invokeAgent(server, job, workspace, options, fire);
            default:
                throw new UnsupportedScheduledCommand(job.command);
        }
    };
}

/** How a fire's turn ended, as far as the dispatcher can see. */
type TurnOutcome =
    | { kind: "reply"; message: AgentMessage | null }
    /**
     * Queued behind a running turn. Enqueuing is not answering: only the lane
     * can say whether the entry ran, was stopped with the run, or was cleared.
     */
    | { kind: "queued"; entryId: string };

async function invokeAgent(
    server: DispatchSurface,
    job: Job,
    workspace: string,
    options: DispatcherOptions,
    fire: FireContext | undefined,
): Promise<AgentInvokeResult> {
    const prompt = String(job.args.prompt ?? "");
    if (!prompt) {
        throw new Error("agent.invoke requires args.prompt");
    }
    const strategy = resolveStrategy(job.sessionStrategy, workspace);
    const { onPinnedSessionCreated } = options;
    // The session id is known before the turn starts on every strategy, so the
    // Work exists, and the history can point at it, while the turn runs.
    const run = (sessionId: string, turn: (watch?: QueuedWatch) => Promise<TurnOutcome>) =>
        trackTurn(server, options.work, job, workspace, sessionId, fire, turn);

    switch (strategy) {
        case "new": {
            const id = `sched-${randomUUID()}`;
            return run(id, () => createWithPrompt(server, workspace, id, prompt));
        }
        case "reuse": {
            const existing = await lookupSession(server, workspace);
            if (!existing) {
                throw new InvalidSessionStrategy(
                    `reuse strategy: no session bound to ${workspace}`,
                );
            }
            return run(existing, () => attachAndPrompt(server, workspace, existing, prompt));
        }
        case "pin": {
            const id = `sched-pin-${job.id}`;
            const pinned = job.pinnedSessionId;
            // A pinned id can outlive its session: manual deletion, a
            // cleanup script, or a wiped sessions dir. Probe before
            // attaching — `session.attach` on a missing session surfaces an
            // opaque `[upstream] Cannot read properties of undefined` rather
            // than a clean not_found, and the old code let that repeat on
            // every fire forever with no path back to a working state.
            // Falling through to the create branch re-pins a fresh session
            // instead, so the job self-heals on its next tick.
            //
            // The deterministic id is probed too, not just the stored pin: a
            // first fire that failed mid-turn (an abort, a provider error)
            // leaves its transcript on disk but never reaches
            // `onPinnedSessionCreated`, so `pinned` is still unset while the
            // session exists — creating it again would fail on the taken id.
            for (const candidate of new Set(pinned ? [pinned, id] : [id])) {
                if (!(await sessionExists(server, workspace, candidate))) continue;
                const result = await run(candidate, () =>
                    attachAndPrompt(server, workspace, candidate, prompt),
                );
                if (candidate !== pinned && onPinnedSessionCreated) {
                    await onPinnedSessionCreated(job.id, candidate, job.generation);
                }
                return result;
            }
            if (pinned) {
                log.warn(
                    `pinned session ${pinned} for job ${job.id} no longer exists; re-creating`,
                );
            }
            const result = await run(id, () => createWithPrompt(server, workspace, id, prompt));
            if (onPinnedSessionCreated) {
                await onPinnedSessionCreated(job.id, id, job.generation);
            }
            return result;
        }
    }
}

/**
 * Run one fire's turn under a Work: record it first, settle it with whatever
 * the turn produced. The fire's own outcome is unchanged — a failed turn still
 * rejects, so history and the failure breaker see what they always saw.
 */
async function trackTurn(
    server: DispatchSurface,
    work: ScheduledWorkHooks | undefined,
    job: Job,
    workspace: string,
    sessionId: string,
    fire: FireContext | undefined,
    turn: (watch: QueuedWatch | undefined) => Promise<TurnOutcome>,
): Promise<AgentInvokeResult> {
    const workId = await work?.onFire({
        jobId: job.id,
        fireId: fire?.fireId ?? randomUUID(),
        title: job.name,
        workspace,
        sessionId,
    });
    // Reported before the turn runs: a fire that outlives its timeout still
    // has to point its history entry at the Work that will hold the answer.
    if (workId !== undefined) fire?.onWork(workId);
    // Started before the prompt: an entry consumed the instant it is enqueued
    // must still be seen.
    const watch = server.queueWatch?.(workspace, sessionId);
    let outcome: TurnOutcome;
    try {
        outcome =
            workId !== undefined && work?.run
                ? await work.run(workId, sessionId, () => turn(watch))
                : await turn(watch);
    } catch (err) {
        watch?.stop();
        if (workId !== undefined) {
            // A stop is not a failure: the turn was cancelled, and saying so
            // keeps the Work's cancelled state reachable.
            const aborted =
                err instanceof ScheduledCommandFailed && err.code === ErrorCodes.Aborted;
            await work?.onFireSettle(
                workId,
                aborted
                    ? { outcome: "cancelled", reason: "stopped by the user" }
                    : {
                          outcome: "error",
                          message: err instanceof Error ? err.message : String(err),
                      },
            );
        }
        throw err;
    }
    if (work !== undefined && workId !== undefined) {
        if (outcome.kind === "queued") {
            await work.onFireQueued?.(workId, outcome.entryId);
            // Whether the entry ever ran decides this Work's ending, so the
            // settle moves to the watcher. Without one (a test stub), fall back
            // to the old "accepted" reading rather than leaving it running.
            if (watch) {
                void watch.wait(outcome.entryId).then(
                    (result) => {
                        watch.stop();
                        return work.onFireSettle(workId, settleForQueued(result, sessionId));
                    },
                    () => work.onFireSettle(workId, { outcome: "cancelled", reason: "queue lost" }),
                );
                return { workId };
            }
            await work.onFireSettle(workId, { outcome: "merged" });
            return { workId };
        }
        watch?.stop();
        const waiting = resolveWaitingInteraction(outcome.message, sessionId);
        await work.onFireSettle(
            workId,
            waiting
                ? { outcome: "waiting", waiting }
                : {
                      outcome: "completed",
                      replyText: outcome.message ? textFromAgentMessage(outcome.message) : "",
                  },
        );
    }
    return workId !== undefined ? { workId } : {};
}

/** Translate the lane's verdict on a queued entry into what the Work records. */
function settleForQueued(outcome: QueuedOutcome, sessionId: string): ScheduledFireSettle {
    switch (outcome.kind) {
        case "answered": {
            const waiting = resolveWaitingInteraction(outcome.message, sessionId);
            if (waiting) return { outcome: "waiting", waiting };
            return {
                outcome: "merged",
                replyText: outcome.message ? textFromAgentMessage(outcome.message) : "",
            };
        }
        case "aborted":
            return { outcome: "cancelled", reason: "stopped with the run it joined" };
        case "failed":
            return { outcome: "error", message: outcome.message };
        case "dropped":
            return { outcome: "cancelled", reason: "removed from the queue before it ran" };
    }
}

async function createWithPrompt(
    server: DispatchSurface,
    workspace: string,
    sessionId: string,
    prompt: string,
): Promise<TurnOutcome> {
    const res = await server.dispatchRpc(
        createRpcRequest(sessionId, RPC.sessionCreate, {
            workspace: asWorkspaceId(workspace),
            sessionId: asSessionId(sessionId),
            initialPrompt: prompt,
        }),
    );
    if (!res.ok) throw new ScheduledCommandFailed(res.error.code, res.error.message);
    return { kind: "reply", message: replyOf(res.result) };
}

/** The turn's final message from a `session.create` / `session.prompt` result. */
function replyOf(result: unknown): AgentMessage | null {
    const message = (result as { assistantMessage?: unknown } | undefined)?.assistantMessage;
    return message && typeof message === "object" ? (message as AgentMessage) : null;
}

/** Resolve the strategy the dispatcher will actually apply.
 *  `reuse` requires an `im://` workspace (fs has no "this peer" concept) —
 *  explicit `reuse` on fs is a hard error so a corrupt job file surfaces
 *  immediately rather than silently falling back to a different behavior.
 *  Unknown stored values coerce to the safe default `new`. */
function resolveStrategy(raw: SessionStrategy | undefined, workspace: string): SessionStrategy {
    if (!raw) return isImWorkspace(workspace) ? "reuse" : "pin";
    if (raw === "new") {
        if (isImWorkspace(workspace)) {
            throw new InvalidSessionStrategy(
                "new strategy is only available for non-channel workspaces",
            );
        }
        return "new";
    }
    if (raw === "reuse") {
        if (!isImWorkspace(workspace)) {
            throw new InvalidSessionStrategy(
                `reuse strategy requires im:// workspace (got ${workspace})`,
            );
        }
        return "reuse";
    }
    if (raw === "pin") {
        if (isImWorkspace(workspace)) {
            throw new InvalidSessionStrategy(
                "pin strategy is only available for non-channel workspaces",
            );
        }
        return "pin";
    }
    return "pin";
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
        const res = await server.dispatchRpc(
            createRpcRequest(randomUUID(), RPC.sessionHistory, {
                workspace: asWorkspaceId(workspace),
                sessionId: asSessionId(sessionId),
            }),
        );
        return res.ok === true;
    } catch (err) {
        log.warn(
            `session.history probe failed for ${sessionId}, treating as absent: ${String(err)}`,
        );
        return false;
    }
}

/** Find the sessionId bound to an IM workspace via the routing table.
 *  `session.list` returns every session under the workspace; we pick the
 *  most recently updated one matching the routing entry. Returns undefined
 *  when nothing is routed yet — the caller decides whether to fall back,
 *  error, or create (currently `reuse` errors). */
async function lookupSession(
    server: DispatchSurface,
    workspace: string,
): Promise<string | undefined> {
    return server.lookupRoute?.(workspace)?.sessionId;
}

async function attachAndPrompt(
    server: DispatchSurface,
    workspace: string,
    sessionId: string,
    prompt: string,
): Promise<TurnOutcome> {
    const attach = await server.dispatchRpc(
        createRpcRequest(randomUUID(), RPC.sessionAttach, {
            workspace: asWorkspaceId(workspace),
            sessionId: asSessionId(sessionId),
        }),
    );
    if (!attach.ok) throw new ScheduledCommandFailed(attach.error.code, attach.error.message);
    return promptWithBusyFallback(server, workspace, sessionId, prompt);
}

/** Deliver a job's prompt, degrading to a queued follow-up when the target
 *  session already has a turn in flight.
 *
 *  `reuse` re-prompts the session bound to the job's chat, and the common way
 *  a job is force-fired is from inside that very conversation's turn — the
 *  agent calling `jobsRunNow` on itself. A bare `session.prompt` there is a
 *  guaranteed self-collision: pi's lane holds a single operation slot and
 *  rejects the second prompt with `LaneBusy` → `SessionBusy`. Failing the
 *  fire is what led the observed IM session to conclude "this is a deadlock".
 *  Queue the prompt as a follow-up instead — consumed at the run's next
 *  `may_finish` boundary — mirroring the IM ingress busy path
 *  (channels/ingress.ts deliverAsFollowUp).
 *
 *  If the run ended between the rejection and the enqueue (mode "idle"), retry
 *  the prompt once so the fire isn't left sitting in an unconsumed inbox. */
async function promptWithBusyFallback(
    server: DispatchSurface,
    workspace: string,
    sessionId: string,
    prompt: string,
): Promise<TurnOutcome> {
    const params = {
        workspace: asWorkspaceId(workspace),
        sessionId: asSessionId(sessionId),
        text: prompt,
    };
    const res = await server.dispatchRpc(createRpcRequest(randomUUID(), RPC.sessionPrompt, params));
    if (res.ok) return { kind: "reply", message: replyOf(res.result) };
    if (res.error.code !== ErrorCodes.SessionBusy) {
        throw new ScheduledCommandFailed(res.error.code, res.error.message);
    }
    const queued = await server.dispatchRpc(
        createRpcRequest(randomUUID(), RPC.sessionFollowUp, params),
    );
    if (!queued.ok) throw new ScheduledCommandFailed(queued.error.code, queued.error.message);
    const queuedResult = queued.result as { mode?: string; entryId?: string } | undefined;
    if (queuedResult?.mode !== "idle") {
        if (typeof queuedResult?.entryId !== "string") {
            throw new Error("session.followUp queued without an entryId");
        }
        return { kind: "queued", entryId: queuedResult.entryId };
    }
    const retry = await server.dispatchRpc(
        createRpcRequest(randomUUID(), RPC.sessionPrompt, params),
    );
    if (!retry.ok) throw new ScheduledCommandFailed(retry.error.code, retry.error.message);
    return { kind: "reply", message: replyOf(retry.result) };
}
