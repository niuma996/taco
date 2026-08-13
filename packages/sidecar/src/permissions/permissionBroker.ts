import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
    CommandPermissionConfig,
    CommandPermissionDecision,
    CommandPermissionRequest,
    CommandPermissionRule,
    CommandPermissionScope,
} from "@taco-ai/protocol";
import type { ImCommandPolicy } from "../channels/imWorkspacePolicy.ts";
import { evaluateCommand, evaluateCommandForImWorkspace } from "./commandPolicy.ts";

interface PendingRequest {
    request: CommandPermissionRequest;
    resolve: (decision: CommandPermissionDecision) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface PermissionBrokerOptions {
    requestTimeoutMs?: number;
    /** Resolves the root display context for a session — routes subagent
     * permission prompts to the root agent tool card. Absent (tests): broker
     * falls back to { sessionId, undefined } so main-session behaviour holds. */
    resolveDisplayContext?: (
        sessionId: string,
    ) => Promise<{ displaySessionId: string; displayToolCallId: string | undefined }>;
    /** Resolved IM command policy for this workspace. Absent = non-IM, use the
     *  global evaluator. Thunk to match the existing globalConfig style. */
    imCommandPolicy?: () => ImCommandPolicy | undefined;
    /** Isolate mode: do not inherit any session/global rules.
     *  Only isStrictReadOnly() commands auto-allow; everything else denies.
     *  Used by read-only subagents (e.g. explorer) so that a user's
     *  root-session allowlist cannot leak into the child's shell execution. */
    readOnly?: boolean;
}

export class PermissionBroker extends EventEmitter {
    private readonly sessionRules = new Map<string, CommandPermissionRule[]>();
    private readonly pending = new Map<string, PendingRequest>();
    private requestTimeoutMs: number;
    private readonly resolveDisplayContext?: PermissionBrokerOptions["resolveDisplayContext"];
    private readonly imCommandPolicy?: PermissionBrokerOptions["imCommandPolicy"];
    private readonly readOnly: boolean;

    constructor(
        private readonly globalConfig: () => CommandPermissionConfig,
        options?: PermissionBrokerOptions,
    ) {
        super();
        this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.resolveDisplayContext = options?.resolveDisplayContext;
        this.imCommandPolicy = options?.imCommandPolicy;
        this.readOnly = options?.readOnly ?? false;
    }

    async evaluateAndRequest(args: {
        sessionId: string;
        toolCallId: string;
        command: string;
        signal?: AbortSignal;
    }): Promise<CommandPermissionDecision> {
        const config = this.globalConfig();

        // Resolve display context — where the UI should surface this prompt.
        // Main-session: { sessionId, undefined }. Subagent: { rootSid, rootAgentTcid }.
        // Resolver failure falls back to main-session shape; never blocks the prompt.
        let displaySessionId = args.sessionId;
        let displayToolCallId: string | undefined;
        if (this.resolveDisplayContext) {
            try {
                const ctx = await this.resolveDisplayContext(args.sessionId);
                displaySessionId = ctx.displaySessionId;
                displayToolCallId = ctx.displayToolCallId;
            } catch {
                // keep main-session fallback shape
            }
        }

        // Inherit rules from the display session (root) when the caller is a
        // subagent — so an approval stored against the root survives across
        // child respawns.
        const ownRules = this.sessionRules.get(args.sessionId) ?? [];
        const inheritedRules =
            displaySessionId !== args.sessionId
                ? (this.sessionRules.get(displaySessionId) ?? [])
                : [];
        // readOnly: drop every rule source so a user's allowlist cannot leak
        // into read-only subagents (explorer).
        const rules = this.readOnly ? [] : [...config.rules, ...ownRules, ...inheritedRules];
        const baseConfig = { ...config, rules };
        const imPolicy = this.imCommandPolicy?.();
        const evaluation = imPolicy
            ? evaluateCommandForImWorkspace(args.command, baseConfig, imPolicy)
            : evaluateCommand(args.command, baseConfig);
        // readOnly: an "ask" (needs UI approval) degrades to deny immediately.
        // The isolated broker has no UI wiring — waiting would hang the
        // explorer for the full requestTimeoutMs before timing out.
        if (this.readOnly) {
            return {
                approved: evaluation.behavior === "allow",
                scope: "once",
                evaluation,
            };
        }
        if (evaluation.behavior !== "ask") {
            return { approved: evaluation.behavior === "allow", scope: "once", evaluation };
        }

        const request: CommandPermissionRequest = {
            requestId: randomUUID(),
            sessionId: args.sessionId,
            toolCallId: args.toolCallId,
            command: args.command,
            evaluation,
            displaySessionId,
            displayToolCallId,
        };
        return await new Promise<CommandPermissionDecision>((resolve) => {
            const finish = (decision: CommandPermissionDecision) => {
                if (timer) clearTimeout(timer);
                this.pending.delete(request.requestId);
                args.signal?.removeEventListener("abort", onAbort);
                resolve(decision);
            };
            const onAbort = () =>
                finish({ approved: false, scope: "once", evaluation, denialReason: "aborted" });
            const timer = setTimeout(() => {
                finish({
                    approved: false,
                    scope: "once",
                    evaluation,
                    denialReason: "timeout",
                });
            }, this.requestTimeoutMs);
            this.pending.set(request.requestId, { request, resolve: finish, timer });
            args.signal?.addEventListener("abort", onAbort, { once: true });
            this.emit("requested", request);
        });
    }

    resolve(
        requestId: string,
        approved: boolean,
        scope: CommandPermissionScope,
    ): CommandPermissionDecision | undefined {
        const pending = this.pending.get(requestId);
        if (!pending) return undefined;
        const decision: CommandPermissionDecision = {
            approved,
            scope,
            evaluation: pending.request.evaluation,
            ...(approved ? {} : { denialReason: "user_denied" as const }),
        };
        if (approved && scope === "session") {
            // Store the rule against the display session (root) so any future
            // subagent respawn inherits it. When the caller is the root itself,
            // displaySessionId === sessionId and this is a no-op.
            const target = pending.request.displaySessionId ?? pending.request.sessionId;
            const rules = this.sessionRules.get(target) ?? [];
            this.sessionRules.set(target, [...rules, pending.request.command]);
        }
        pending.resolve(decision);
        return decision;
    }

    /** Like resolve() but tags the rejection as system-initiated, not user-initiated. */
    private rejectAsAborted(requestId: string): void {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        const decision: CommandPermissionDecision = {
            approved: false,
            scope: "once",
            evaluation: pending.request.evaluation,
            denialReason: "aborted",
        };
        pending.resolve(decision);
    }

    getRequest(requestId: string): CommandPermissionRequest | undefined {
        return this.pending.get(requestId)?.request;
    }

    /** Reject all pending requests for a session and remove its in-memory rules. */
    cleanupSession(sessionId: string): void {
        this.sessionRules.delete(sessionId);
        for (const requestId of [...this.pending.keys()]) {
            const pending = this.pending.get(requestId);
            if (pending?.request.sessionId === sessionId) {
                this.rejectAsAborted(requestId);
            }
        }
    }

    /** Reject every pending request — used when a workspace is disposed. */
    cleanupAll(): void {
        for (const requestId of [...this.pending.keys()]) {
            this.rejectAsAborted(requestId);
        }
    }
}
