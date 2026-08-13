/**
 * DeferredToolRegistry — workspace-level deferred-tool candidate directory and lazy-load factory.
 *
 * Separates "which tools can be loaded on demand" from "which session has loaded which":
 *   - registry is a workspace-level snapshot: candidates with definition, summary, loading
 *     strategy, and a lazy-load factory.
 *   - each session holds its own loaded set via SessionToolController (see sessionToolController.ts).
 *
 * Future: MCP adapters inject/remove candidates on connect/disconnect.
 * This module has no MCP dependency.
 */

import type { TacoTool } from "../tools/index.ts";

export type ToolCandidateSource = "builtin" | "mcp";

export type ToolLoadingMode = "deferred" | "always";

/** A single loadable tool candidate. */
export interface ToolCandidate {
    /** Globally unique name. MCP adapters are responsible for mapping to valid unique names. */
    readonly name: string;
    /** One-line summary, shown in the AddTools.description listing. */
    readonly summary: string;
    /** Loading strategy. always = resident from session start; deferred = loaded on demand. */
    readonly loading: ToolLoadingMode;
    /** Source for future grouping / troubleshooting in tools.list. */
    readonly source: ToolCandidateSource;
    /** Lazy-load factory — tool object is only instantiated when loaded. */
    load(): Promise<TacoTool>;
}

export interface DeferredToolRegistry {
    /** All candidates (frozen snapshot, does not change with MCP connect/disconnect). */
    listCandidates(): readonly ToolCandidate[];
    /** Candidates still in deferred mode — shown in AddTools.description. */
    listDeferred(): readonly ToolCandidate[];
    /** Candidates marked always — attached to the session at attach time. */
    listAlways(): readonly ToolCandidate[];
    /** Load a candidate by name; returns undefined for unknown names. */
    load(name: string): Promise<TacoTool | undefined>;
    /** Release external resources (MCP connections); optional. */
    dispose?(): Promise<void>;
}

/** Options for constructing a registry. */
export interface DeferredToolRegistryOptions {
    /** All candidates; constructor validates name uniqueness. */
    candidates: readonly ToolCandidate[];
    /** Optional external-resource cleanup (e.g. MCP connections) forwarded by dispose(). */
    dispose?: () => Promise<void>;
}

export class DefaultDeferredToolRegistry implements DeferredToolRegistry {
    private readonly byName = new Map<string, ToolCandidate>();
    private readonly deferredNames: string[];
    private readonly alwaysNames: string[];
    private readonly disposeFn: (() => Promise<void>) | undefined;

    constructor(options: DeferredToolRegistryOptions) {
        for (const candidate of options.candidates) {
            if (this.byName.has(candidate.name)) {
                throw new Error(`duplicate dynamic tool candidate name: ${candidate.name}`);
            }
            this.byName.set(candidate.name, candidate);
        }
        this.deferredNames = options.candidates
            .filter((c) => c.loading === "deferred")
            .map((c) => c.name);
        this.alwaysNames = options.candidates
            .filter((c) => c.loading === "always")
            .map((c) => c.name);
        this.disposeFn = options.dispose;
    }

    listCandidates(): readonly ToolCandidate[] {
        return [...this.byName.values()];
    }

    listDeferred(): readonly ToolCandidate[] {
        // deferredNames is pre-computed at construction so the entry always exists.
        return this.deferredNames.map((n) => this.byName.get(n) as ToolCandidate);
    }

    listAlways(): readonly ToolCandidate[] {
        return this.alwaysNames.map((n) => this.byName.get(n) as ToolCandidate);
    }

    async load(name: string): Promise<TacoTool | undefined> {
        const candidate = this.byName.get(name);
        if (!candidate) return undefined;
        return candidate.load();
    }

    async dispose(): Promise<void> {
        await this.disposeFn?.();
    }
}
