import type { ExtensionContributionSummary, ExtensionWorkspaceStatus } from "@taco-ai/protocol";
import type { WorkspaceContribution } from "./types.ts";

export function emptyContributions(): ExtensionContributionSummary {
    return {
        tools: [],
        deferredTools: [],
        tags: [],
        skillDirs: [],
        commandPermissionRules: [],
        contextHooks: 0,
        toolCallHooks: 0,
        toolResultHooks: 0,
        systemPrompts: 0,
        workspaceActivators: 0,
        sessionActivators: 0,
    };
}

interface Activation {
    contributions: ExtensionContributionSummary;
    probe?: WorkspaceContribution["activationStatus"];
    reason?: string;
    failure?: string;
}

/** Scope-owned observations; never re-run activators or retain workspace state globally. */
export class WorkspaceExtensionDiagnostics {
    private readonly entries = new Map<string, Activation[]>();

    add(name: string, activation: Activation): void {
        const entries = this.entries.get(name) ?? [];
        entries.push(activation);
        this.entries.set(name, entries);
    }

    record(
        name: string,
        contribution?: WorkspaceContribution,
        failure?: string,
        reason?: string,
    ): void {
        this.add(name, {
            contributions: {
                ...emptyContributions(),
                tools: contribution?.tools?.map((entry) => entry.tool.name) ?? [],
                deferredTools:
                    contribution?.toolCandidates?.map((entry) => entry.candidate.name) ?? [],
                contextHooks: contribution?.contextHooks?.length ?? 0,
                toolCallHooks: contribution?.toolCallHooks?.length ?? 0,
                toolResultHooks: contribution?.toolResultHooks?.length ?? 0,
                systemPrompts: contribution?.systemPrompt ? 1 : 0,
                sessionActivators: contribution?.sessionActivators?.length ?? 0,
                commandPermissionRules: [...(contribution?.commandPermissionRules ?? [])],
            },
            probe: contribution?.activationStatus,
            failure,
            reason,
        });
    }

    async report(): Promise<ExtensionWorkspaceStatus[]> {
        return Promise.all(
            [...this.entries].map(async ([name, activations]) => {
                const contributions = emptyContributions();
                let reason: string | undefined;
                let failed = false;
                for (const activation of activations) {
                    if (activation.failure) {
                        failed = true;
                        reason = activation.failure;
                        continue;
                    }
                    try {
                        const status = await activation.probe?.();
                        if (status && !status.active) {
                            reason ??= status.reason;
                            continue;
                        }
                    } catch (error) {
                        failed = true;
                        reason = error instanceof Error ? error.message : String(error);
                        continue;
                    }
                    reason ??= activation.reason;
                    const c = activation.contributions;
                    for (const key of [
                        "tools",
                        "deferredTools",
                        "tags",
                        "skillDirs",
                        "commandPermissionRules",
                    ] as const) {
                        contributions[key] = [
                            ...new Set([...(contributions[key] ?? []), ...(c[key] ?? [])]),
                        ];
                    }
                    for (const key of [
                        "contextHooks",
                        "toolCallHooks",
                        "toolResultHooks",
                        "systemPrompts",
                        "sessionActivators",
                    ] as const)
                        contributions[key] += c[key];
                }
                // Tags are declarations, not evidence that a conditional hook is active.
                const active =
                    contributions.tools.length +
                        contributions.deferredTools.length +
                        (contributions.skillDirs?.length ?? 0) +
                        (contributions.commandPermissionRules?.length ?? 0) +
                        contributions.contextHooks +
                        contributions.toolCallHooks +
                        contributions.toolResultHooks +
                        contributions.systemPrompts +
                        contributions.sessionActivators >
                    0;
                return {
                    name,
                    state: failed ? "failed" : active ? "active" : "inactive",
                    reason: failed || !active ? reason : undefined,
                    contributions,
                };
            }),
        );
    }
}
