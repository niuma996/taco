import type { WorkspaceId } from "@taco-ai/protocol";
import type { WorkspaceRuntime } from "../runtime/workspace.ts";

interface WorkspaceEntry {
    state: "starting" | "ready" | "closing";
    runtime?: WorkspaceRuntime;
    build?: Promise<WorkspaceRuntime>;
    close?: Promise<WorkspaceRuntime | undefined>;
}

class WorkspaceInvalidatedError extends Error {}

/** Owns publication and closing so a runtime is never reused during disposal. */
export class WorkspaceRegistry {
    private readonly entries = new Map<WorkspaceId, WorkspaceEntry>();
    private closingAll?: Promise<void>;
    private stopped = false;

    constructor(private readonly build: (cwd: WorkspaceId) => Promise<WorkspaceRuntime>) {}

    get(cwd: WorkspaceId): WorkspaceRuntime | undefined {
        const entry = this.entries.get(cwd);
        return entry?.state === "ready" ? entry.runtime : undefined;
    }

    list(): WorkspaceRuntime[] {
        return [...this.entries.values()].flatMap((entry) =>
            entry.state === "ready" && entry.runtime ? [entry.runtime] : [],
        );
    }

    keys(): WorkspaceId[] {
        return [...this.entries.keys()].filter((key) => this.get(key) !== undefined);
    }

    async ensure(cwd: WorkspaceId): Promise<WorkspaceRuntime> {
        if (this.stopped) throw new Error("workspace registry is stopped");
        if (this.closingAll) await this.closingAll;
        if (this.stopped) throw new Error("workspace registry is stopped");
        const existing = this.entries.get(cwd);
        if (existing?.state === "ready" && existing.runtime) return existing.runtime;
        if (existing?.state === "starting" && existing.build) return existing.build;
        if (existing?.state === "closing") {
            await existing.close;
            return this.ensure(cwd);
        }
        const entry: WorkspaceEntry = { state: "starting" };
        this.entries.set(cwd, entry);
        entry.build = Promise.resolve().then(async () => {
            try {
                const runtime = await this.build(cwd);
                if (entry.state === "closing") {
                    await runtime.dispose();
                    throw new WorkspaceInvalidatedError(
                        `workspace ${cwd} invalidated during construction`,
                    );
                }
                entry.runtime = runtime;
                entry.state = "ready";
                return runtime;
            } catch (error) {
                if (entry.state !== "closing" && this.entries.get(cwd) === entry) {
                    this.entries.delete(cwd);
                }
                throw error;
            }
        });
        return entry.build;
    }

    /** Inject a ready runtime, primarily for isolated server tests. */
    publish(key: WorkspaceId, runtime: WorkspaceRuntime): void {
        if (this.entries.has(key)) throw new Error(`workspace ${key} already registered`);
        this.entries.set(key, { state: "ready", runtime });
    }

    async remove(cwd: WorkspaceId): Promise<WorkspaceRuntime | undefined> {
        const entry = this.entries.get(cwd);
        if (!entry) return undefined;
        if (entry.state === "closing") return entry.close;
        entry.state = "closing";
        entry.close = Promise.resolve().then(async () => {
            try {
                if (entry.runtime) {
                    await entry.runtime.dispose();
                    return entry.runtime;
                }
                try {
                    await entry.build;
                } catch (error) {
                    if (!(error instanceof WorkspaceInvalidatedError)) throw error;
                }
                return undefined;
            } finally {
                if (this.entries.get(cwd) === entry) this.entries.delete(cwd);
            }
        });
        return entry.close;
    }

    start(): void {
        this.stopped = false;
    }

    stop(): Promise<void> {
        this.stopped = true;
        return this.disposeAll();
    }

    /** Wait for constructors and attempt every close even when one fails. */
    disposeAll(): Promise<void> {
        if (this.closingAll) return this.closingAll;
        const closes = [...this.entries.keys()].map((key) => this.remove(key));
        const closing = Promise.allSettled(closes)
            .then((results) => {
                const errors = results.flatMap((result) =>
                    result.status === "rejected" ? [result.reason] : [],
                );
                if (errors.length) throw new AggregateError(errors, "workspace disposal failed");
            })
            .finally(() => {
                if (this.closingAll === closing) this.closingAll = undefined;
            });
        this.closingAll = closing;
        return closing;
    }
}
