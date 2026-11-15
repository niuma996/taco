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

import { createLogger } from "../../lib/logger.ts";
import type { TacoTool } from "../../tools/index.ts";

const log = createLogger("deferred-tools");

export type ToolCandidateSource = "builtin" | "mcp" | "extension";

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
    /** Contributing extension when source is "extension". */
    readonly extensionName?: string;
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
    /** Prepare dynamic candidates once before a surface needs their definitions. */
    prepare?(): Promise<void>;
    /** Release external resources (MCP connections); optional. */
    dispose?(): Promise<void>;
}

/** Options for constructing a registry. */
export interface DeferredToolRegistryOptions {
    /** All candidates; constructor validates name uniqueness. */
    candidates: readonly ToolCandidate[];
    /** Optional external-resource cleanup (e.g. MCP connections) forwarded by dispose(). */
    dispose?: () => Promise<void>;
    /** Lazy source for candidates whose definitions require I/O, such as MCP. */
    prepare?: () => Promise<readonly ToolCandidate[]>;
}

export class DefaultDeferredToolRegistry implements DeferredToolRegistry {
    private readonly byName = new Map<string, ToolCandidate>();
    private readonly deferredNames: string[];
    private readonly alwaysNames: string[];
    private readonly disposeFn: (() => Promise<void>) | undefined;
    private readonly prepareFn: (() => Promise<readonly ToolCandidate[]>) | undefined;
    private preparePromise?: Promise<void>;

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
        this.prepareFn = options.prepare;
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

    async prepare(): Promise<void> {
        this.preparePromise ??= this.prepareDynamicCandidates();
        try {
            await this.preparePromise;
        } catch (err) {
            // A failed prepare must not poison every later attach.
            this.preparePromise = undefined;
            throw err;
        }
    }

    private async prepareDynamicCandidates(): Promise<void> {
        if (!this.prepareFn) return;
        const candidates = await this.prepareFn();
        // Validate the whole batch before installing any of it.
        const seen = new Set<string>();
        for (const candidate of candidates) {
            if (this.byName.has(candidate.name) || seen.has(candidate.name)) {
                throw new Error(`duplicate dynamic tool candidate name: ${candidate.name}`);
            }
            seen.add(candidate.name);
        }
        for (const candidate of candidates) {
            this.byName.set(candidate.name, candidate);
            if (candidate.loading === "deferred") this.deferredNames.push(candidate.name);
            else this.alwaysNames.push(candidate.name);
        }
    }

    async dispose(): Promise<void> {
        await this.disposeFn?.();
    }
}

/** Add static extension candidates without changing the base registry's MCP lifecycle. */
export class CompositeDeferredToolRegistry implements DeferredToolRegistry {
    private readonly extensionByName = new Map<string, ToolCandidate>();

    constructor(
        private readonly base: DeferredToolRegistry,
        extensionCandidates: readonly ToolCandidate[],
    ) {
        const baseNames = new Set(base.listCandidates().map((candidate) => candidate.name));
        for (const candidate of extensionCandidates) {
            if (baseNames.has(candidate.name)) {
                log.warn(
                    `skipping extension tool candidate "${candidate.name}" from "${candidate.extensionName ?? "unknown"}": a builtin candidate already owns the name`,
                );
                continue;
            }
            if (this.extensionByName.has(candidate.name)) {
                log.warn(
                    `skipping extension tool candidate "${candidate.name}" from "${candidate.extensionName ?? "unknown"}": an earlier extension already owns the name`,
                );
                continue;
            }
            this.extensionByName.set(candidate.name, candidate);
        }
    }

    listCandidates(): readonly ToolCandidate[] {
        return [...this.base.listCandidates(), ...this.extensionByName.values()];
    }

    listDeferred(): readonly ToolCandidate[] {
        return this.listCandidates().filter((candidate) => candidate.loading === "deferred");
    }

    listAlways(): readonly ToolCandidate[] {
        return this.listCandidates().filter((candidate) => candidate.loading === "always");
    }

    async load(name: string): Promise<TacoTool | undefined> {
        const extension = this.extensionByName.get(name);
        return extension ? extension.load() : this.base.load(name);
    }

    async prepare(): Promise<void> {
        await this.base.prepare?.();
        for (const candidate of this.base.listCandidates()) {
            const extension = this.extensionByName.get(candidate.name);
            if (extension) {
                log.warn(
                    `skipping extension tool candidate "${candidate.name}" from "${extension.extensionName ?? "unknown"}": an MCP candidate already owns the name`,
                );
                this.extensionByName.delete(candidate.name);
            }
        }
    }

    async dispose(): Promise<void> {
        await this.base.dispose?.();
    }
}
