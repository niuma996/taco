import type {
    AgentRuntime,
    AgentScope,
    ClaudeCodePermissionMode,
    CodexAgentConfig,
    CodexApprovalPolicy,
    CodexSandboxMode,
} from "@taco-ai/protocol";

/** What the form produces; the pane adds `previousAgentType`. */
export interface AgentFormValue {
    scope: AgentScope;
    agentType: string;
    description: string;
    whenToUse?: string;
    runtime: AgentRuntime;
    maxTurns: number;
    /** Wall-clock budget for a background spawn, in minutes. Unset = derived. */
    timeoutMinutes?: number;
    systemPrompt: string;
    tools?: string[];
    permissionMode?: ClaudeCodePermissionMode;
    /** `claude-code` only: the directory it runs in. */
    cwd?: string;
    /** `codex` only: SDK engine settings. */
    codex?: CodexAgentConfig;
}

export interface AgentFormDraft {
    scope: AgentScope;
    agentType: string;
    description: string;
    whenToUse: string;
    maxTurns: string;
    timeoutMinutes: string;
    systemPrompt: string;
    noRolePrompt: boolean;
    tools: string;
    permissionMode: ClaudeCodePermissionMode;
    cwd: string;
    codexCwd: string;
    codexModel: string;
    codexSandbox: CodexSandboxMode;
    codexApprovalPolicy: CodexApprovalPolicy;
}

/** Codex retains the schema's turn budget even though its adapter uses SDK turns. */
export function defaultMaxTurns(): number {
    return 100;
}

export function agentFormDefaults(
    existing: AgentFormValue | undefined,
    fixedScope: AgentScope | undefined,
    cwdChoices: ReadonlyArray<string>,
): AgentFormDraft {
    return {
        scope: existing?.scope ?? fixedScope ?? "global",
        agentType: existing?.agentType ?? "",
        description: existing?.description ?? "",
        whenToUse: existing?.whenToUse ?? "",
        maxTurns: String(existing?.maxTurns ?? defaultMaxTurns()),
        timeoutMinutes:
            existing?.timeoutMinutes === undefined ? "" : String(existing.timeoutMinutes),
        systemPrompt: existing?.systemPrompt ?? "",
        // A new definition requires an explicit choice to omit its role body.
        noRolePrompt: existing !== undefined && existing.systemPrompt.trim() === "",
        tools: existing?.tools?.join(", ") ?? "",
        permissionMode: existing?.permissionMode ?? "auto",
        cwd: existing?.cwd ?? cwdChoices[0] ?? "",
        codexCwd: existing?.codex?.cwd ?? cwdChoices[0] ?? "",
        codexModel: existing?.codex?.model ?? "",
        codexSandbox: existing?.codex?.sandbox ?? "read-only",
        codexApprovalPolicy: existing?.codex?.approvalPolicy ?? "never",
    };
}

/** Empty tools select Claude Code's full preset, rather than an empty whitelist. */
export function parseAgentTools(raw: string): string[] | undefined {
    const names = raw.split(/[\s,]+/).filter(Boolean);
    return names.length > 0 ? names : undefined;
}

/** Keep raw text until validation: coercion alone accepts 01, 1.0 and exponents. */
export function isExactAgentInteger(raw: string, max: number): boolean {
    const text = raw.trim();
    const value = Number(text);
    return Number.isInteger(value) && value >= 1 && value <= max && String(value) === text;
}

/** Convert a validated draft, retaining each runtime's empty/omitted wire semantics. */
export function agentDraftToValue(
    draft: AgentFormDraft,
    runtime: AgentRuntime,
    existing: AgentFormValue | undefined,
): AgentFormValue {
    const timeout = draft.timeoutMinutes.trim();
    return {
        scope: draft.scope,
        agentType: draft.agentType.trim(),
        description: draft.description.trim(),
        whenToUse: draft.whenToUse.trim() || undefined,
        runtime,
        maxTurns: Number(draft.maxTurns.trim()),
        ...(timeout !== "" ? { timeoutMinutes: Number(timeout) } : {}),
        systemPrompt: draft.noRolePrompt ? "" : draft.systemPrompt,
        ...(runtime === "claude-code"
            ? {
                  tools: parseAgentTools(draft.tools),
                  permissionMode: draft.permissionMode,
                  ...(draft.cwd !== "" ? { cwd: draft.cwd } : {}),
              }
            : {}),
        ...(runtime === "codex"
            ? {
                  // There is no Codex tool picker; preserve the whitelist verbatim.
                  ...(existing?.tools !== undefined ? { tools: existing.tools } : {}),
                  codex: {
                      ...(draft.codexCwd !== "" ? { cwd: draft.codexCwd } : {}),
                      ...(draft.codexModel.trim() !== "" ? { model: draft.codexModel.trim() } : {}),
                      sandbox: draft.codexSandbox,
                      approvalPolicy: draft.codexApprovalPolicy,
                  },
              }
            : {}),
    };
}
