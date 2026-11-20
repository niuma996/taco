import type {
    MessageAttachment,
    SessionId,
    WorkspaceId,
    WorktreeBase,
    WorktreeHandoffParams,
} from "@taco-ai/protocol";
import type { ImageContent } from "../runtime/pi/types.ts";

export interface WorktreeStartRequest {
    readonly sourceWorkspace: WorkspaceId;
    readonly sourceSessionId: SessionId;
    readonly name: string;
    readonly base?: WorktreeBase;
    readonly task: string;
    readonly images?: ImageContent[];
    readonly attachments?: readonly MessageAttachment[];
    readonly signal?: AbortSignal;
}

export type WorktreeStartResult = WorktreeHandoffParams;
export type WorktreeStart = (request: WorktreeStartRequest) => Promise<WorktreeStartResult>;
