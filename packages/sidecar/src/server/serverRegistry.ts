/** Optional settings fan-out for embedded hosts with multiple independent runtimes. */

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
