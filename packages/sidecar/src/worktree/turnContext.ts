/** Ephemeral source-turn data used only while that turn's tool call is running. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { MessageAttachment, SessionId } from "@taco-ai/protocol";
import type { ImageContent } from "../runtime/pi/types.ts";

export interface WorktreeTurn {
    readonly sourceSessionId: SessionId;
    readonly text: string;
    readonly images?: ImageContent[];
    readonly attachments?: readonly MessageAttachment[];
}

const current = new AsyncLocalStorage<WorktreeTurn>();

export function withWorktreeTurn<T>(turn: WorktreeTurn, operation: () => Promise<T>): Promise<T> {
    return current.run(turn, operation);
}

export function getWorktreeTurn(): WorktreeTurn | undefined {
    return current.getStore();
}
