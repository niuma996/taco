/**
 * ServerRegistry — process-level fan-out of settings setters to every
 * resident SidecarServer.
 *
 * Background: in daemon mode the sidecar runs TWO SidecarServers in one
 * process — an `imHost` (owns IM workspaces + channels) and a
 * `schedulerSidecar` (owns fs workspaces; scheduled jobs run here). Before
 * this registry, `settings.write` only invoked setters on whichever server
 * handled the RPC — typically the desktop's NDJSON connection server,
 * which is neither. Three latent bugs followed:
 *   1. `defaultModel` / `defaultProvider` written from a desktop stayed at
 *      boot-time value on `schedulerSidecar`, so the next scheduled job's
 *      `session.create` built a workspace with the stale default.
 *   2. `customProviders` — same staleness path.
 *   3. `instructions` — `buildWorkspace` did not pass `instructionsConfig`
 *      at all (see `ServerRegistry` companion fix on the workspace build
 *      path); `refreshInstructions` only iterated already-built workspaces.
 *
 * Use:
 *  - `runDaemon` constructs one registry and threads it through
 *    `SharedSidecarDeps.serverRegistry`.
 *  - Each `SidecarServer.start()` registers itself; `stop()` removes it.
 *  - The `settings.write` handler iterates `registry.all()` and applies
 *    each setter to every server. Stdio / test sidecars do not construct
 *    a registry — the handler falls back to a single-element `[server]`
 *    iteration so existing stub-server tests pass unchanged.
 *
 * Failure isolation: a setter that throws on one server must not stop the
 * others from receiving the patch. The fan-out caller (settings handler)
 * is expected to wrap each invocation in try/catch and log; this registry
 * intentionally does not swallow errors so they remain visible during
 * development. Tests cover both single-server (no registry) and
 * multi-server (registry with N entries) paths.
 *
 * Ownership: this is a daemon-process singleton. Stdio single-process
 * sidecars and tests skip construction — the handler's
 * `serverRegistry?.all() ?? [server]` fallback preserves the pre-fix
 * behaviour byte-for-byte.
 */

import type { ServerRpcSurface } from "../runtime/serverRpcSurface.ts";

export class ServerRegistry {
    private readonly servers = new Set<ServerRpcSurface>();

    /** Register a server as a fan-out target. Idempotent. */
    add(server: ServerRpcSurface): void {
        this.servers.add(server);
    }

    /**
     * Remove a server. Idempotent — safe to call after close or with an
     * unknown reference (no throw on missing).
     */
    remove(server: ServerRpcSurface): void {
        this.servers.delete(server);
    }

    /**
     * Snapshot array of every registered server.
     *
     * Returned as an array (not a live Set view) because callers iterate
     * synchronously and may also remove a server mid-iteration in tests;
     * a live view would risk `Set.prototype.forEach` skipping entries
     * after mutation. Cheap enough — registrations are O(dozens) at most.
     */
    all(): ServerRpcSurface[] {
        return [...this.servers];
    }

    /** Current registration count — used by tests. */
    size(): number {
        return this.servers.size;
    }
}
