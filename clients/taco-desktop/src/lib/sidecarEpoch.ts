/** Tracks the current sidecar process identity for each workspace. */
export class SidecarEpochs {
    private readonly instanceIdByWorkspace = new Map<string, string>();

    observe(workspace: string, instanceId: string): "new" | "unchanged" | "replaced" {
        const previous = this.instanceIdByWorkspace.get(workspace);
        this.instanceIdByWorkspace.set(workspace, instanceId);
        if (!previous) return "new";
        return previous === instanceId ? "unchanged" : "replaced";
    }

    clearAll(): void {
        this.instanceIdByWorkspace.clear();
    }
}
