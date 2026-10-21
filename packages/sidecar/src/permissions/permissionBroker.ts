import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
    CommandEvaluation,
    CommandPermissionConfig,
    CommandPermissionDecision,
    CommandPermissionRequest,
    CommandPermissionRule,
    CommandPermissionScope,
} from "@taco-ai/protocol";
import { asSessionId, asToolCallId } from "@taco-ai/protocol";
import type { ImCommandPolicy } from "../channels/imWorkspacePolicy.ts";
import {
    type CommandEvaluationContext,
    evaluateCommand,
    evaluateCommandForImWorkspace,
    evaluateReadOnlyCommand,
} from "./commandPolicy.ts";
import type { ShellLanguage } from "./shellParser.ts";

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
    /**
     * The directories a shell command may `cd` into.
     *
     * A thunk, not a value: the set grows with the workspace's associated
     * directories, which the user can change while a session is live. A
     * captured list would keep refusing a `cd` into a directory the user
     * has since associated (or allow one they have since detached).
     *
     * This is the ONLY thing an association widens. The command itself is
     * still evaluated against the allow/deny rules, so an associated
     * directory does not make a mutating command auto-allowed.
     */
    commandContext?: () => Pick<CommandEvaluationContext, "cwd" | "allowedRoots">;
    /** False when no client can answer a prompt (IM with no desktop connected);
     *  an ask then denies at once instead of blocking the turn until timeout. */
    hasApprover?: () => boolean;
}

export class PermissionBroker extends EventEmitter {
    private readonly sessionRules = new Map<string, CommandPermissionRule[]>();
    private readonly pending = new Map<string, PendingRequest>();
    private requestTimeoutMs: number;
    private readonly resolveDisplayContext?: PermissionBrokerOptions["resolveDisplayContext"];
    private readonly imCommandPolicy?: PermissionBrokerOptions["imCommandPolicy"];
    private readonly readOnly: boolean;
    private readonly commandContext: PermissionBrokerOptions["commandContext"];
    private readonly hasApprover: () => boolean;

    constructor(
        private readonly globalConfig: () => CommandPermissionConfig,
        options?: PermissionBrokerOptions,
    ) {
        super();
        this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.resolveDisplayContext = options?.resolveDisplayContext;
        this.imCommandPolicy = options?.imCommandPolicy;
        this.readOnly = options?.readOnly ?? false;
        this.commandContext = options?.commandContext;
        this.hasApprover = options?.hasApprover ?? (() => true);
    }

    async evaluateAndRequest(args: {
        sessionId: string;
        toolCallId: string;
        command: string;
        cwd?: string;
        language?: ShellLanguage;
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
        const allow = this.readOnly
            ? []
            : [...(config.allow ?? config.rules ?? []), ...ownRules, ...inheritedRules];
        const baseConfig = { ...config, allow };
        const imPolicy = this.imCommandPolicy?.();
        const context = {
            ...this.commandContext?.(),
            ...(args.cwd ? { cwd: args.cwd } : {}),
            ...(args.language ? { language: args.language } : {}),
        };
        const evaluation = this.readOnly
            ? evaluateReadOnlyCommand(args.command, context)
            : imPolicy
              ? evaluateCommandForImWorkspace(args.command, baseConfig, imPolicy, context)
              : evaluateCommand(args.command, baseConfig, context);
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
        if (!this.hasApprover()) {
            return { approved: false, scope: "once", evaluation, denialReason: "no_approver" };
        }

        const request: CommandPermissionRequest = {
            requestId: randomUUID(),
            sessionId: asSessionId(args.sessionId),
            toolCallId: asToolCallId(args.toolCallId),
            command: args.command,
            evaluation,
            displaySessionId: asSessionId(displaySessionId),
            displayToolCallId:
                displayToolCallId === undefined ? undefined : asToolCallId(displayToolCallId),
        };
        return await this.awaitDecision(request, args.signal);
    }

    /**
     * Request approval for a global-config change.
     *
     * Unlike a shell command there is nothing to evaluate against the
     * allow/deny rules — a config patch is not a command, and the rules
     * describe command text. So this asks unconditionally: the user sees the
     * fields being changed and decides.
     *
     * Scope is deliberately "once" only. Persisting an approval would mean
     * storing a config patch as a reusable rule, and the next patch would
     * differ in the fields it touches — a stored match on "any
     * commandPermissions change" is exactly the kind of blanket grant that
     * lets a later turn widen its own permissions.
     */
    async requestConfigApproval(args: {
        sessionId: string;
        toolCallId: string;
        /** Config fields the patch touches — shown on the approval prompt. */
        fields: readonly string[];
        signal?: AbortSignal;
    }): Promise<CommandPermissionDecision> {
        const evaluation: CommandEvaluation = {
            behavior: "ask",
            risk: "workspaceWrite",
            reason: "changes the global taco configuration",
            // Not persistable — see the method doc.
            persistentAllowed: false,
        };
        if (!this.hasApprover()) {
            return { approved: false, scope: "once", evaluation, denialReason: "no_approver" };
        }

        // Same display-context resolution as the command path, so a
        // subagent's request lands on the root agent's tool card.
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

        const request: CommandPermissionRequest = {
            requestId: randomUUID(),
            sessionId: asSessionId(args.sessionId),
            toolCallId: asToolCallId(args.toolCallId),
            command: `config: ${args.fields.join(", ")}`,
            evaluation,
            kind: "config",
            configFields: args.fields,
            displaySessionId: asSessionId(displaySessionId),
            displayToolCallId:
                displayToolCallId === undefined ? undefined : asToolCallId(displayToolCallId),
        };
        return await this.awaitDecision(request, args.signal);
    }

    /**
     * Park a request until the user answers, the abort signal fires, or the
     * timeout elapses. Every settle path funnels through `finish`, which is
     * also how the UI learns about a non-user outcome.
     */
    private awaitDecision(
        request: CommandPermissionRequest,
        signal: AbortSignal | undefined,
    ): Promise<CommandPermissionDecision> {
        return new Promise<CommandPermissionDecision>((resolve) => {
            const finish = (decision: CommandPermissionDecision) => {
                if (timer) clearTimeout(timer);
                this.pending.delete(request.requestId);
                signal?.removeEventListener("abort", onAbort);
                resolve(decision);
                this.emit("resolved", { request, decision });
            };
            const onAbort = () =>
                finish({
                    approved: false,
                    scope: "once",
                    evaluation: request.evaluation,
                    denialReason: "aborted",
                });
            const timer = setTimeout(() => {
                finish({
                    approved: false,
                    scope: "once",
                    evaluation: request.evaluation,
                    denialReason: "timeout",
                });
            }, this.requestTimeoutMs);
            this.pending.set(request.requestId, { request, resolve: finish, timer });
            signal?.addEventListener("abort", onAbort, { once: true });
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
        if (
            approved &&
            (pending.request.evaluation.matchedList === "deny" ||
                pending.request.evaluation.persistentAllowed === false)
        )
            scope = "once";
        const decision: CommandPermissionDecision = {
            approved,
            scope,
            evaluation: pending.request.evaluation,
            ...(approved ? {} : { denialReason: "user_denied" as const }),
        };
        if (approved && scope === "session" && pending.request.evaluation.matchedList !== "deny") {
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
