import type { CommandPermissionRequest } from "@taco-ai/protocol";
import type { WorkRecord } from "./workTypes.ts";

interface PendingPermission {
    readonly workspace: string;
    readonly requestId: string;
    readonly sessionId: string;
    readonly toolCallId: string;
}

/** Broker requests are process-local observations; no commands, grants or request ids enter the Work store. */
export class WorkPermissionProjection {
    private readonly pending = new Map<string, PendingPermission>();
    constructor(
        private readonly instanceId: string,
        private readonly onChange: () => void,
    ) {}

    requested(workspace: string, request: CommandPermissionRequest): void {
        this.pending.set(JSON.stringify([workspace, request.requestId]), {
            workspace,
            requestId: request.requestId,
            sessionId: request.sessionId,
            toolCallId: request.toolCallId,
        });
        this.onChange();
    }

    resolved(workspace: string, requestId: string): void {
        if (this.pending.delete(JSON.stringify([workspace, requestId]))) this.onChange();
    }

    project(work: WorkRecord): WorkRecord {
        if (work.status !== "running") return work;
        const sessionId = work.childSessionId ?? work.parentSessionId;
        for (const request of this.pending.values()) {
            if (request.workspace !== work.workspace || request.sessionId !== sessionId) continue;
            return {
                ...work,
                status: "waiting",
                waiting: {
                    toolName: "permission",
                    toolCallId: request.toolCallId,
                    sessionId,
                    requestId: request.requestId,
                    instanceId: this.instanceId,
                    description: "Command approval required",
                },
            };
        }
        return work;
    }

    clear(): void {
        this.pending.clear();
    }
}
