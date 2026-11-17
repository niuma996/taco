/** Compile-only guarantees for handler runtime requirements. */
import { registerAdhocMethod, registerMethod } from "./methodRegistry.ts";

function checkRuntimeContexts() {
    // @ts-expect-error ad-hoc probes are process-level and never construct runtimes
    registerAdhocMethod("test.runtime", true, async () => null);
    registerMethod("workspaceEnsure", false, async ({ workspace, cwd }) => {
        const absent: undefined = workspace;
        // @ts-expect-error lifecycle handlers do not receive a runtime
        workspace.listSessions();
        void absent;
        return { cwd };
    });
    registerMethod("sessionList", true, async ({ workspace, cwd }) => {
        void workspace.listSessions();
        return { workspace: cwd, sessions: [] };
    });
}
void checkRuntimeContexts;
