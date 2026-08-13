import { PushMethods, type SessionId, type WorkspaceId } from "@taco-ai/protocol";
import type { EmitPushFn } from "../server/pushTypes.ts";

export interface PlanSnapshotPublisher {
    publishPlanState(
        cwd: WorkspaceId,
        sessionId: SessionId,
        state: { active: boolean; currentSlug: string | null },
    ): void;
}

export class PlanPushAdapter implements PlanSnapshotPublisher {
    constructor(private readonly emitPush: EmitPushFn) {}
    publishPlanState(
        cwd: WorkspaceId,
        sessionId: SessionId,
        state: { active: boolean; currentSlug: string | null },
    ): void {
        this.emitPush(PushMethods.PlanStateUpdated, cwd, sessionId, { sessionId, ...state });
    }
}

export class NoopPlanPushAdapter implements PlanSnapshotPublisher {
    publishPlanState(): void {}
}
