/**
 * WorkspaceRuntime fixture: two temp dirs (cwd + sessionsRoot) with the
 * runtime wired to them. `cleanup` disposes the runtime and removes both
 * dirs — tests call it from their `after` hook.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asWorkspaceId } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { WorkspaceRuntime, type WorkspaceRuntimeOptions } from "../../src/runtime/workspace.ts";

export interface TestWorkspace {
    ws: WorkspaceRuntime;
    cwd: string;
    sessionsRoot: string;
    cleanup(): Promise<void>;
}

export function createTestWorkspace(
    opts: Omit<WorkspaceRuntimeOptions, "cwd" | "scope" | "sessionsRoot" | "providerKeyStore"> & {
        /** Temp-dir name tag, so a leaked dir points back at its test file. */
        prefix?: string;
        /** Runs after the dirs exist and before the runtime is built — e.g. seed a CLAUDE.md the constructor reads. */
        setup?: (cwd: string) => void;
        providerKeyStore?: ProviderKeyStore;
    } = {},
): TestWorkspace {
    const { prefix, setup, providerKeyStore, ...runtimeOpts } = opts;
    const tag = prefix ? `${prefix}-` : "";
    const cwd = mkdtempSync(join(tmpdir(), `taco-ws-${tag}`));
    const sessionsRoot = mkdtempSync(join(tmpdir(), `taco-sessions-${tag}`));
    const removeDirs = () => {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(sessionsRoot, { recursive: true, force: true });
    };
    let ws: WorkspaceRuntime;
    try {
        setup?.(cwd);
        ws = new WorkspaceRuntime({
            ...runtimeOpts,
            cwd: asWorkspaceId(cwd),
            sessionsRoot,
            providerKeyStore: providerKeyStore ?? new ProviderKeyStore({}),
        });
    } catch (e) {
        removeDirs();
        throw e;
    }
    return {
        ws,
        cwd,
        sessionsRoot,
        async cleanup() {
            await ws.dispose();
            removeDirs();
        },
    };
}
