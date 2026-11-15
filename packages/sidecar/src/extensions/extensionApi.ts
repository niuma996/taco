/**
 * createExtensionApi — the facade handed to each extension's factory.
 * Each register* method checks declared permissions; if unauthorized,
 * logger.warn + recordUnauthorized + early return; otherwise writes the
 * contribution to the registry. Built-in template hooks (output-redaction)
 * bypass this entirely and register directly via
 * `registry.addToolResultInterceptor` in `registerBuiltinExtensions`.
 */

import type { SystemPromptContributor } from "../prompts/buildSystemPrompt.ts";
import type { TagSpec } from "../tags/types.ts";
import type { ExtensionRegistry } from "./registry.ts";
import { EXTERNAL_SOURCE } from "./registry.ts";
import type {
    ContextHook,
    ExtensionApi,
    ExtensionLogger,
    ExtensionManifest,
    ExtensionPermission,
    ExtensionSource,
    ExtensionToolCandidate,
    ToolCallHook,
    ToolResultHook,
    WorkspaceActivator,
    WorkspaceContribution,
} from "./types.ts";

/**
 * Human-readable label for each `ExtensionPermission`, used when an extension
 * tries to use a capability it didn't declare. Keyed by the union itself so
 * TypeScript flags any new permission that ships without a label here.
 */
const PERM_LABELS: Record<ExtensionPermission, string> = {
    context: "registerContextHook",
    toolCall: "registerToolCallInterceptor",
    toolResult: "registerToolResultInterceptor",
    tools: "registerTool",
    systemPrompt: "registerSystemPrompt",
    tags: "registerTag",
    commandPermissions: "workspace commandPermissionRules",
};

const WORKSPACE_PERMISSIONS: Record<
    Exclude<keyof WorkspaceContribution, "source">,
    ExtensionPermission
> = {
    contextHooks: "context",
    toolCallHooks: "toolCall",
    toolResultHooks: "toolResult",
    tools: "tools",
    toolCandidates: "tools",
    systemPrompt: "systemPrompt",
    commandPermissionRules: "commandPermissions",
} as const;

export function createExtensionApi(
    manifest: ExtensionManifest,
    registry: ExtensionRegistry,
    logger: ExtensionLogger,
    source: ExtensionSource = EXTERNAL_SOURCE,
): ExtensionApi {
    const declared = new Set<ExtensionPermission>(manifest.permissions);

    const check = (perm: ExtensionPermission, method = PERM_LABELS[perm]): boolean => {
        if (declared.has(perm)) return true;
        logger.warn(
            `extension "${manifest.name}" called ${method} without declaring "${perm}" permission; ignored`,
        );
        registry.recordUnauthorized(manifest.name, perm);
        return false;
    };

    const authorizeWorkspaceContribution = (
        contribution: WorkspaceContribution,
    ): WorkspaceContribution => {
        const authorized: WorkspaceContribution = {};
        for (const key of Object.keys(WORKSPACE_PERMISSIONS) as Array<
            keyof typeof WORKSPACE_PERMISSIONS
        >) {
            if (contribution[key] === undefined) continue;
            if (!check(WORKSPACE_PERMISSIONS[key], `workspace contribution "${key}"`)) continue;
            Object.assign(authorized, { [key]: contribution[key] });
        }
        if (authorized.tools) {
            authorized.tools = authorized.tools.map((entry) => ({
                ...entry,
                name: manifest.name,
            }));
        }
        if (authorized.toolCandidates) {
            authorized.toolCandidates = authorized.toolCandidates.map((entry) => ({
                ...entry,
                name: manifest.name,
            }));
        }
        return authorized;
    };

    return {
        manifest,
        logger,
        registerContextHook(hook: ContextHook): void {
            if (!check("context")) return;
            registry.addContextHook(source, hook);
        },
        registerToolCallInterceptor(hook: ToolCallHook): void {
            if (!check("toolCall")) return;
            registry.addToolCallInterceptor(hook);
        },
        registerToolResultInterceptor(hook: ToolResultHook): void {
            if (!check("toolResult")) return;
            registry.addToolResultInterceptor(source, hook);
        },
        registerTool(tool, options): void {
            if (!check("tools")) return;
            const existing = registry.toolsWithSource().find((e) => e.tool.name === tool.name);
            if (existing) {
                logger.warn(
                    `extension "${manifest.name}" overrode tool "${tool.name}" from extension "${existing.name}"`,
                );
            }
            registry.addTool(manifest.name, tool, options?.fileAccess);
        },
        registerToolCandidate(candidate: ExtensionToolCandidate): void {
            if (!check("tools")) return;
            registry.addToolCandidate(manifest.name, candidate);
        },
        registerWorkspaceActivator(activator: WorkspaceActivator): void {
            registry.addWorkspaceActivator(source, manifest.name, async (ctx) => {
                const contribution = await activator(ctx);
                return contribution ? authorizeWorkspaceContribution(contribution) : undefined;
            });
        },
        registerSystemPrompt(contributor: SystemPromptContributor): void {
            if (!check("systemPrompt")) return;
            registry.addSystemPromptContributor(contributor);
        },
        registerTag(spec: TagSpec): void {
            if (!check("tags")) return;
            const ok = registry.addExtensionTag(manifest.name, spec.name, spec);
            if (!ok) {
                logger.warn(
                    `extension "${manifest.name}" registerTag("${spec.name}") was rejected`,
                );
                registry.recordFailed(
                    manifest.name,
                    `registerTag("${spec.name}") rejected (collision / invalid spec)`,
                );
            }
        },
    };
}
