/**
 * ExtensionRegistry — collects contributions from external extensions,
 * partitioned by source for ordered consumption by the harness.
 *
 * Bucketing matters: harness.on(...) registration order determines
 * message-pipeline order. Built-in hooks always run before external hooks.
 * Sources: `builtin` — first-party template hooks; `external` — npm/local.
 * Workspace activators (cwd-dependent, e.g. git-context) register via
 * `addWorkspaceActivator`; `activateExtensions` invokes them per workspace.
 */

import { sidecarVersion } from "../runtime/runtimeResources.ts";
import { registerExtensionTag } from "../tags/registry.ts";
import type { TagSpec } from "../tags/types.ts";
import type { TacoTool } from "../tools/index.ts";
import type { BuiltinManifest, BuiltinRegistryApi } from "./builtinContract.ts";
import type {
    ContextHook,
    ExtensionPermission,
    ExtensionSource,
    SystemPromptContributor,
    ToolCallHook,
    ToolResultHook,
    WorkspaceActivator,
} from "./types.ts";

export interface LoadedEntry {
    name: string;
    version: string;
    source: ExtensionSource;
    permissions: ReadonlyArray<ExtensionPermission>;
    /** manifest taco.description, may be absent. */
    description?: string;
    /** manifest taco.whenToUse, may be absent. */
    whenToUse?: string;
    /** Tag names this extension registered via `registerTag`. */
    tags?: ReadonlyArray<string>;
}

export interface RegistryReport {
    loaded: LoadedEntry[];
    failed: Array<{ name: string; reason: string }>;
    unauthorized: Array<{ name: string; method: ExtensionPermission }>;
    /** Extension names matched by disabledExtensions and never loaded (recorded by the loader's subtraction step). */
    disabled: string[];
}

export interface ContextHookBuckets {
    builtins: ContextHook[];
    external: ContextHook[];
}

export interface ToolResultHookBuckets {
    builtins: ToolResultHook[];
    external: ToolResultHook[];
}

export interface WorkspaceActivatorEntry {
    readonly extName: string;
    readonly source: ExtensionSource;
    readonly activator: WorkspaceActivator;
}

/** sources that can register a tool or system-prompt contributor today. */
export const EXTERNAL_SOURCE: ExtensionSource = "external";

export class ExtensionRegistry {
    private readonly _tools: Array<{ name: string; tool: TacoTool }> = [];
    private readonly _systemPrompt: SystemPromptContributor[] = [];
    private readonly _contextHooks: { builtins: ContextHook[]; external: ContextHook[] } = {
        builtins: [],
        external: [],
    };
    private readonly _toolCallHooks: ToolCallHook[] = [];
    private readonly _toolResultHooks: ToolResultHookBuckets = { builtins: [], external: [] };
    private readonly _workspaceActivators: WorkspaceActivatorEntry[] = [];
    private readonly _extensionTagIndex: Map<string, Set<string>> = new Map();
    private readonly _report: { loaded: LoadedEntry[] } & Pick<
        RegistryReport,
        "failed" | "unauthorized" | "disabled"
    > = { loaded: [], failed: [], unauthorized: [], disabled: [] };

    /**
     * Append a tool contributed by extension `name`. The name is retained
     * so downstream consumers (WorkspaceRuntime.dedupOverride) can emit
     * "extension X overrode built-in tool Y" warnings per design §4.3.
     */
    addTool(name: string, tool: TacoTool): void {
        this._tools.push({ name, tool });
    }

    addSystemPromptContributor(contributor: SystemPromptContributor): void {
        this._systemPrompt.push(contributor);
    }

    addContextHook(source: ExtensionSource, hook: ContextHook): void {
        if (source === "builtin") this._contextHooks.builtins.push(hook);
        else this._contextHooks.external.push(hook);
    }

    addToolCallInterceptor(hook: ToolCallHook): void {
        this._toolCallHooks.push(hook);
    }

    /** bucket a tool_result hook by source. `builtin` runs first in the pipeline
     *  (see attachedSession.ts §6.4). */
    addToolResultInterceptor(source: ExtensionSource, hook: ToolResultHook): void {
        if (source === "builtin") this._toolResultHooks.builtins.push(hook);
        else this._toolResultHooks.external.push(hook);
    }

    /**
     * Register a workspace activator. The activator is invoked later, once per
     * workspace, by `activateExtensions` to produce a frozen
     * `WorkspaceExtensionSet`.
     */
    addWorkspaceActivator(
        source: ExtensionSource,
        extName: string,
        activator: WorkspaceActivator,
    ): void {
        this._workspaceActivators.push({ source, extName, activator });
    }

    /**
     * Register an extension-supplied tag via `registerExtensionTag(spec)`.
     * Records the contributed name in a per-extension index so `recordLoaded`
     * can later attach `tags?: string[]` to the `LoadedEntry`. Returns `false`
     * if validation rejected the spec (caller logs the reason and records the
     * extension as failed).
     */
    addExtensionTag(extName: string, name: string, spec: TagSpec): boolean {
        if (!registerExtensionTag(spec)) return false;
        let set = this._extensionTagIndex.get(extName);
        if (!set) {
            set = new Set();
            this._extensionTagIndex.set(extName, set);
        }
        set.add(name);
        return true;
    }

    /** Snapshot the tag names `extName` contributed. Used by `loadOne` to
     *  fill `LoadedEntry.tags` before `recordLoaded`. */
    extensionTagsFor(extName: string): string[] {
        return [...(this._extensionTagIndex.get(extName) ?? [])];
    }

    recordFailed(name: string, reason: string): void {
        this._report.failed.push({ name, reason });
    }

    recordUnauthorized(name: string, method: ExtensionPermission): void {
        this._report.unauthorized.push({ name, method });
    }

    recordLoaded(entry: LoadedEntry): void {
        this._report.loaded.push(entry);
    }

    /**
     * Record an extension name that was skipped because it appears in
     * disabledExtensions. Called by the loader during the
     * `actual = extensions - disabled` subtraction — the extension is never
     * imported, so we only have its name (no version/permissions/manifest).
     */
    recordDisabled(name: string): void {
        this._report.disabled.push(name);
    }

    tools(): TacoTool[] {
        return this._tools.map((e) => e.tool);
    }

    /**
     * Like {@link tools} but retains the contributing extension's name.
     * Used by WorkspaceRuntime to emit override warnings (design §4.3).
     */
    toolsWithSource(): Array<{ name: string; tool: TacoTool }> {
        return [...this._tools];
    }

    systemPromptContributors(): SystemPromptContributor[] {
        return [...this._systemPrompt];
    }

    contextHooks(): ContextHookBuckets {
        return {
            builtins: [...this._contextHooks.builtins],
            external: [...this._contextHooks.external],
        };
    }

    toolCallHooks(): ToolCallHook[] {
        return [...this._toolCallHooks];
    }

    toolResultHooks(): ToolResultHookBuckets {
        return {
            builtins: [...this._toolResultHooks.builtins],
            external: [...this._toolResultHooks.external],
        };
    }

    workspaceActivators(): WorkspaceActivatorEntry[] {
        return [...this._workspaceActivators];
    }

    get report(): RegistryReport {
        return {
            loaded: [...this._report.loaded],
            failed: [...this._report.failed],
            unauthorized: [...this._report.unauthorized],
            disabled: [...this._report.disabled],
        };
    }
}

/**
 * Registers a list of built-in extensions into the registry. Called once at
 * startup before external extensions. Built-in hooks bypass permission checks
 * and always land in the `builtins` bucket so they run before external hooks.
 *
 * Each builtin registers with `permissions: []` (trust-bypass signal).
 * The dispatcher is generic — it contains no knowledge of specific builtins.
 */
export async function registerBuiltinExtensions(
    registry: ExtensionRegistry,
    disabledExtensions: ReadonlySet<string> = new Set(),
    manifests: readonly BuiltinManifest[] = [],
): Promise<void> {
    const version = sidecarVersion();

    // Narrowed view handed to `manifest.register` — deliberately excludes
    // recordLoaded/recordFailed so a builtin cannot double-record itself;
    // the dispatcher below owns that bookkeeping exclusively.
    const builtinApi: BuiltinRegistryApi = {
        addExtensionTag: (extName, name, spec) => registry.addExtensionTag(extName, name, spec),
        addWorkspaceActivator: (source, extName, activator) =>
            registry.addWorkspaceActivator(source, extName, activator),
        addToolResultInterceptor: (source, hook) => registry.addToolResultInterceptor(source, hook),
    };

    for (const manifest of manifests) {
        if (disabledExtensions.has(manifest.name)) {
            registry.recordDisabled(manifest.name);
            continue;
        }

        try {
            if (manifest.register) {
                await manifest.register(builtinApi);
            }

            if (manifest.activator) {
                registry.addWorkspaceActivator(
                    "builtin",
                    manifest.name,
                    await manifest.activator(),
                );
            }

            // recordLoaded runs LAST, after register/activator succeed, so:
            //   - `extensionTagsFor` sees any tags the builtin just registered
            //     (register runs addExtensionTag before this point)
            //   - a throwing register/activator lands the entry in `failed`
            //     only, never both `loaded` and `failed`
            const tags = registry.extensionTagsFor(manifest.name);
            registry.recordLoaded({
                name: manifest.name,
                version,
                source: "builtin",
                permissions: [],
                description: manifest.description,
                whenToUse: manifest.whenToUse,
                ...(tags.length > 0 ? { tags } : {}),
            });
        } catch (e) {
            registry.recordFailed(manifest.name, (e as Error).message);
        }
    }
}
