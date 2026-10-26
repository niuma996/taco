/**
 * @taco-ai/shared — RPC method names and the fast-method set.
 *
 * The method names come from the contract table in `@taco-ai/protocol`,
 * which is the single source of truth for every wire method: its name, its
 * params type, its result type and its client routing scope. This module
 * re-exports the names so existing importers keep working, and adds the
 * timeout policy that is a client concern rather than a wire contract.
 */

export { RPC, type RpcMethodName } from "@taco-ai/protocol";

import { RPC } from "@taco-ai/protocol";

/**
 * Methods that must answer promptly or not at all.
 *
 * These are pure reads: the server answers from disk or memory without waiting
 * on a model, a subprocess, or the network. A daemon that has accepted the
 * connection and finished the handshake but cannot answer one of these within
 * seconds is not "busy", it is broken — and the caller is better served by an
 * error it can retry than by a promise that never settles. The default RPC
 * ceiling is deliberately huge (a `session.prompt` can stream for minutes);
 * applying it to a metadata read is what let a wedged daemon leave the
 * desktop's sidebar empty with nothing to catch.
 *
 * Deliberately NOT in this set: anything model- or network-bound
 * (`session.prompt` / `compact` / `submitAnswers`, `provider.listModels`,
 * `channels.*` bind/verify, which waits on a human); anything unbounded in
 * practice (`session.steer` / `followUp`, whose compaction wait can outlast
 * the 15s ceiling, leaving the caller unsure whether the message landed); and
 * any mutation (`session.cancelQueued`, `checkpoints.restore`, `memory.write`,
 * `*.create/update/delete`), where a spurious timeout is ambiguous.
 */
export const FAST_RPC_METHODS: ReadonlySet<string> = new Set<string>([
    RPC.workspaceList,
    RPC.workspaceAssociationsGet,
    RPC.workspaceAssociationsResolve,
    RPC.sessionList,
    RPC.sessionHistory,
    RPC.sessionEventsGet,
    RPC.sessionSnapshotGet,
    RPC.sessionTasksGet,
    RPC.sessionTaskHistoryGet,
    RPC.sessionPlanStateGet,
    RPC.sessionListModels,
    RPC.sessionContextInfo,
    RPC.providersList,
    RPC.providersRevealKey,
    RPC.settingsGet,
    RPC.extensionsStatus,
    RPC.channelsList,
    RPC.channelsListConversations,
    RPC.imPolicyGet,
    RPC.toolsList,
    RPC.agentsList,
    RPC.agentsContent,
    RPC.skillsList,
    RPC.skillContent,
    RPC.checkpointsList,
    RPC.memoryList,
    RPC.mcpListServers,
    RPC.mcpGetConfig,
]);

/**
 * Ceiling for `FAST_RPC_METHODS`. 15s is far above any healthy local read
 * (measured: a 31MB / 262-file session store answers `session.list` in
 * milliseconds) while still leaving room for a loaded machine mid-cold-start,
 * where the daemon may be competing with the app's own startup for CPU.
 */
export const FAST_RPC_TIMEOUT_MS = 15_000;
