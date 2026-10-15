/**
 * Registry of live WorkspaceRuntime instances, keyed by workspaceKey
 * (im:// URL for IM workspaces, fs path for IDE workspaces).
 *
 * Split out of `SidecarServer` because the map is the process-level
 * workspace table while the server is connection-scoped: every config
 * hot-reload setter, broadcast, and shutdown path walks it. The
 * single-flight shares the key space so concurrent ensureWorkspace()
 * calls for the same cwd share one build promise — without this N
 * parallel RPCs each run the full asset-load + MCP-discovery +
 * push-wire path, leaking the loser's MCP handles and double-writing
 * the imPolicyStore.
 *
 * Publish-timing contract: builders call `publish()` themselves at the
 * exact point the runtime is fully constructed but before any yield —
 * never in `ensure()` after the build settles. A post-build set would
 * reopen the half-built-state window (see
 * SidecarServer.buildWorkspace's set() comment for the full race).
 */

import type { WorkspaceId } from "@taco-ai/protocol";
import { SingleFlight } from "../lib/async.ts";
import type { WorkspaceRuntime } from "../runtime/workspace.ts";

export class WorkspaceRegistry {
    private readonly map = new Map<WorkspaceId, WorkspaceRuntime>();
    private readonly flight: SingleFlight<WorkspaceId, WorkspaceRuntime>;

    constructor(build: (cwd: WorkspaceId) => Promise<WorkspaceRuntime>) {
        this.flight = new SingleFlight(build);
    }

    get(cwd: WorkspaceId): WorkspaceRuntime | undefined {
        return this.map.get(cwd);
    }

    /** All live runtimes — config hot-reload fan-out iterates this. */
    list(): WorkspaceRuntime[] {
        return [...this.map.values()];
    }

    keys(): WorkspaceId[] {
        return [...this.map.keys()];
    }

    async ensure(cwd: WorkspaceId): Promise<WorkspaceRuntime> {
        const cached = this.map.get(cwd);
        if (cached) return cached;
        return this.flight.run(cwd);
    }

    /**
     * Register a freshly built runtime. Exists as a method (rather than
     * a raw map) only to keep the builder-side publish timing explicit
     * — see the class doc.
     */
    publish(key: WorkspaceId, ws: WorkspaceRuntime): void {
        this.map.set(key, ws);
    }

    unpublish(key: WorkspaceId): void {
        this.map.delete(key);
    }

    /**
     * Dispose and remove one workspace. Returns the disposed runtime, or
     * undefined when the key was absent (no dispose attempted). A
     * dispose() rejection propagates and the entry stays — the historical
     * inline behavior.
     */
    async remove(cwd: WorkspaceId): Promise<WorkspaceRuntime | undefined> {
        const ws = this.map.get(cwd);
        if (!ws) return undefined;
        await ws.dispose();
        this.map.delete(cwd);
        return ws;
    }

    /** Dispose every workspace in insertion order, then clear the map. */
    async disposeAll(): Promise<void> {
        for (const ws of this.map.values()) {
            await ws.dispose();
        }
        this.map.clear();
    }

    /**
     * Drop in-flight construction promises. Distinct from disposeAll:
     * reloadMcpServers wants workspaces gone but lets racing builders
     * finish, while stop() must also cancel the single-flight table.
     */
    clearFlight(): void {
        this.flight.clear();
    }
}
