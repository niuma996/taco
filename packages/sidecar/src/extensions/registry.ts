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

import type { ExtensionContributionSummary, ExtensionDisabledEntry } from "@taco-ai/protocol";
import { registerExtensionTag, tagRegistry, unregisterExtensionTag } from "../tags/registry.ts";
import type { TagSpec } from "../tags/types.ts";
import type { FileAccess } from "../tools/fileAccess.ts";
import {
    extensionFileAccessSnapshot,
    registerExtensionFileAccess,
    restoreExtensionFileAccess,
} from "../tools/fileAccess.ts";
import type { TacoTool } from "../tools/index.ts";
import type { BuiltinManifest, BuiltinRegistryApi } from "./builtinContract.ts";
import { resolveExtensionConfig } from "./configuration.ts";
import type {
    ContextHook,
    ExtensionPermission,
    ExtensionSource,
    ExtensionToolCandidateWithSource,
    SessionActivator,
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
    configSchema?: Record<string, unknown>;
    contributions: ExtensionContributionSummary;
}

export interface RegistryReport {
    loaded: LoadedEntry[];
    failed: Array<{ name: string; reason: string; stage?: "load" | "workspace" | "session" }>;
    unauthorized: Array<{ name: string; method: ExtensionPermission }>;
    /** Extension names matched by disabledExtensions and never loaded (recorded by the loader's subtraction step). */
    disabled: string[];
    disabledEntries: ExtensionDisabledEntry[];
}

const EMPTY_CONTRIBUTIONS = (): ExtensionContributionSummary => ({
    tools: [],
    deferredTools: [],
    tags: [],
    contextHooks: 0,
    toolCallHooks: 0,
    toolResultHooks: 0,
    systemPrompts: 0,
    workspaceActivators: 0,
    sessionActivators: 0,
});

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
    readonly config?: Readonly<Record<string, unknown>>;
}

export interface SessionActivatorEntry {
    readonly extName: string;
    readonly source: ExtensionSource;
    readonly activator: SessionActivator;
    readonly config?: Readonly<Record<string, unknown>>;
}

export interface ExtensionRegistryCheckpoint {
    readonly tools: number;
    readonly toolCandidates: number;
    readonly systemPrompt: number;
    readonly builtinContextHooks: number;
    readonly externalContextHooks: number;
    readonly toolCallHooks: number;
    readonly builtinToolResultHooks: number;
    readonly externalToolResultHooks: number;
    readonly workspaceActivators: number;
    readonly sessionActivators: number;
    readonly extensionSkillDirs: number;
    readonly extensionTagIndex: ReadonlyMap<string, ReadonlySet<string>>;
    readonly tagNames: ReadonlySet<string>;
    readonly extensionFileAccess: ReadonlyMap<string, FileAccess>;
    readonly contributions: ReadonlyMap<string, ExtensionContributionSummary>;
}

/** sources that can register a tool or system-prompt contributor today. */
export const EXTERNAL_SOURCE: ExtensionSource = "external";

export class ExtensionRegistry {
    private readonly _tools: Array<{ name: string; tool: TacoTool; fileAccess?: FileAccess }> = [];
    private readonly _toolCandidates: ExtensionToolCandidateWithSource[] = [];
    private readonly _systemPrompt: SystemPromptContributor[] = [];
    private readonly _contextHooks: { builtins: ContextHook[]; external: ContextHook[] } = {
        builtins: [],
        external: [],
    };
    private readonly _toolCallHooks: ToolCallHook[] = [];
    private readonly _toolResultHooks: ToolResultHookBuckets = { builtins: [], external: [] };
    private readonly _workspaceActivators: WorkspaceActivatorEntry[] = [];
    private readonly _sessionActivators: SessionActivatorEntry[] = [];
    private readonly _extensionSkillDirs: string[] = [];
    private readonly _extensionTagIndex: Map<string, Set<string>> = new Map();
    private readonly _contributions = new Map<string, ExtensionContributionSummary>();
    private readonly _disabledEntries = new Map<string, ExtensionDisabledEntry>();
    private runtimeConfig: {
        disabled: ReadonlySet<string>;
        values: Record<string, unknown>;
        extensions: ReadonlySet<string>;
    } = {
        disabled: new Set(),
        values: {},
        extensions: new Set(),
    };
    private readonly _report: { loaded: LoadedEntry[] } & Pick<
        RegistryReport,
        "failed" | "unauthorized" | "disabled"
    > = { loaded: [], failed: [], unauthorized: [], disabled: [] };

    checkpoint(): ExtensionRegistryCheckpoint {
        // Loading is serial and every contribution is append-only. The global
        // snapshots cover the two registries whose entries live outside this object.
        return {
            tools: this._tools.length,
            toolCandidates: this._toolCandidates.length,
            systemPrompt: this._systemPrompt.length,
            builtinContextHooks: this._contextHooks.builtins.length,
            externalContextHooks: this._contextHooks.external.length,
            toolCallHooks: this._toolCallHooks.length,
            builtinToolResultHooks: this._toolResultHooks.builtins.length,
            externalToolResultHooks: this._toolResultHooks.external.length,
            workspaceActivators: this._workspaceActivators.length,
            sessionActivators: this._sessionActivators.length,
            extensionSkillDirs: this._extensionSkillDirs.length,
            extensionTagIndex: new Map(
                [...this._extensionTagIndex].map(([name, tags]) => [name, new Set(tags)]),
            ),
            tagNames: new Set(Object.keys(tagRegistry)),
            extensionFileAccess: extensionFileAccessSnapshot(),
            contributions: new Map(
                [...this._contributions].map(([name, value]) => [
                    name,
                    {
                        ...value,
                        tools: [...value.tools],
                        deferredTools: [...value.deferredTools],
                        tags: [...value.tags],
                        ...(value.skillDirs ? { skillDirs: [...value.skillDirs] } : {}),
                    },
                ]),
            ),
        };
    }

    rollback(checkpoint: ExtensionRegistryCheckpoint): void {
        this._tools.length = checkpoint.tools;
        this._toolCandidates.length = checkpoint.toolCandidates;
        this._systemPrompt.length = checkpoint.systemPrompt;
        this._contextHooks.builtins.length = checkpoint.builtinContextHooks;
        this._contextHooks.external.length = checkpoint.externalContextHooks;
        this._toolCallHooks.length = checkpoint.toolCallHooks;
        this._toolResultHooks.builtins.length = checkpoint.builtinToolResultHooks;
        this._toolResultHooks.external.length = checkpoint.externalToolResultHooks;
        this._workspaceActivators.length = checkpoint.workspaceActivators;
        this._sessionActivators.length = checkpoint.sessionActivators;
        this._extensionSkillDirs.length = checkpoint.extensionSkillDirs;
        this._extensionTagIndex.clear();
        for (const [name, tags] of checkpoint.extensionTagIndex) {
            this._extensionTagIndex.set(name, new Set(tags));
        }
        for (const name of Object.keys(tagRegistry)) {
            if (!checkpoint.tagNames.has(name)) unregisterExtensionTag(name);
        }
        restoreExtensionFileAccess(checkpoint.extensionFileAccess);
        this._contributions.clear();
        for (const [name, value] of checkpoint.contributions) {
            this._contributions.set(name, value);
        }
    }

    private contribution(name: string): ExtensionContributionSummary {
        let value = this._contributions.get(name);
        if (!value) {
            value = EMPTY_CONTRIBUTIONS();
            this._contributions.set(name, value);
        }
        return value;
    }

    private static addName(list: string[], name: string): void {
        if (!list.includes(name)) list.push(name);
    }

    captureConfiguration(
        disabled: ReadonlySet<string>,
        values: Record<string, unknown>,
        extensions: readonly string[] = [],
    ): void {
        this.runtimeConfig = {
            disabled: new Set(disabled),
            values: structuredClone(values),
            extensions: new Set(extensions),
        };
    }

    configurationSnapshot(): {
        disabled: ReadonlySet<string>;
        values: Record<string, unknown>;
        extensions: ReadonlySet<string>;
    } {
        return this.runtimeConfig;
    }

    /**
     * Append a tool contributed by extension `name`. The name is retained
     * so downstream consumers (WorkspaceRuntime.dedupOverride) can emit
     * "extension X overrode built-in tool Y" warnings per design §4.3.
     */
    addTool(name: string, tool: TacoTool, fileAccess?: FileAccess): void {
        this._tools.push({ name, tool, ...(fileAccess ? { fileAccess } : {}) });
        registerExtensionFileAccess(tool.name, fileAccess);
        ExtensionRegistry.addName(this.contribution(name).tools, tool.name);
    }

    addToolCandidate(
        name: string,
        contribution: ExtensionToolCandidateWithSource["candidate"],
    ): void {
        this._toolCandidates.push({ name, candidate: contribution });
        registerExtensionFileAccess(contribution.name, contribution.fileAccess);
        ExtensionRegistry.addName(this.contribution(name).deferredTools, contribution.name);
    }

    addSystemPromptContributor(contributor: SystemPromptContributor, name = "unknown"): void {
        this._systemPrompt.push(contributor);
        this.contribution(name).systemPrompts++;
    }

    addContextHook(source: ExtensionSource, hook: ContextHook, name = "unknown"): void {
        if (source === "builtin") this._contextHooks.builtins.push(hook);
        else this._contextHooks.external.push(hook);
        this.contribution(name).contextHooks++;
    }

    addToolCallInterceptor(hook: ToolCallHook, name = "unknown"): void {
        this._toolCallHooks.push(hook);
        this.contribution(name).toolCallHooks++;
    }

    /** bucket a tool_result hook by source. `builtin` runs first in the pipeline
     *  (see attachedSession.ts §6.4). */
    addToolResultInterceptor(
        source: ExtensionSource,
        hook: ToolResultHook,
        name = "unknown",
    ): void {
        if (source === "builtin") this._toolResultHooks.builtins.push(hook);
        else this._toolResultHooks.external.push(hook);
        this.contribution(name).toolResultHooks++;
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
        config?: Readonly<Record<string, unknown>>,
    ): void {
        this._workspaceActivators.push({ source, extName, activator, config });
        this.contribution(extName).workspaceActivators++;
    }

    addSessionActivator(
        source: ExtensionSource,
        extName: string,
        activator: SessionActivator,
        config?: Readonly<Record<string, unknown>>,
    ): void {
        this._sessionActivators.push({ source, extName, activator, config });
        this.contribution(extName).sessionActivators++;
    }

    /**
     * Record the skill directories an enabled builtin ships
     * (`BuiltinManifest.skillDirs`, paths relative to `resourceRoot()`).
     * Disabled builtins never reach this — `registerBuiltinExtensions` skips
     * them — so their bundled skills are absent from the scan entirely rather
     * than filtered out by name.
     */
    addExtensionSkillDirs(dirs: readonly string[], name = "unknown"): void {
        this._extensionSkillDirs.push(...dirs);
        this.contribution(name).skillDirs = [
            ...new Set([...(this.contribution(name).skillDirs ?? []), ...dirs]),
        ];
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
        ExtensionRegistry.addName(this.contribution(extName).tags, name);
        return true;
    }

    /** Snapshot the tag names `extName` contributed. Used by `loadOne` to
     *  fill `LoadedEntry.tags` before `recordLoaded`. */
    extensionTagsFor(extName: string): string[] {
        return [...(this._extensionTagIndex.get(extName) ?? [])];
    }

    recordFailed(
        name: string,
        reason: string,
        stage: "load" | "workspace" | "session" = "load",
    ): void {
        if (stage !== "load") {
            const existing = this._report.failed.findIndex(
                (entry) => entry.name === name && entry.stage === stage,
            );
            if (existing !== -1) {
                this._report.failed[existing] = { name, reason, stage };
                return;
            }
        }
        this._report.failed.push({ name, reason, stage });
    }

    recordUnauthorized(name: string, method: ExtensionPermission): void {
        this._report.unauthorized.push({ name, method });
    }

    recordLoaded(entry: Omit<LoadedEntry, "contributions">): void {
        const contributions = this.contribution(entry.name);
        this._report.loaded.push({
            ...entry,
            contributions: {
                ...contributions,
                tools: [...contributions.tools],
                deferredTools: [...contributions.deferredTools],
                tags: [...contributions.tags],
            },
        });
    }

    /**
     * Record an extension name that was skipped because it appears in
     * disabledExtensions. Called by the loader during the
     * `actual = extensions - disabled` subtraction — the extension is never
     * imported, so we only have its name (no version/permissions/manifest).
     */
    recordDisabled(name: string, details: Omit<ExtensionDisabledEntry, "name"> = {}): void {
        if (!this._report.disabled.includes(name)) this._report.disabled.push(name);
        if (!this._disabledEntries.has(name)) this._disabledEntries.set(name, { name, ...details });
    }

    tools(): TacoTool[] {
        return this._tools.map((e) => e.tool);
    }

    /**
     * Like {@link tools} but retains the contributing extension's name.
     * Used by WorkspaceRuntime to emit override warnings (design §4.3).
     */
    toolsWithSource(): Array<{ name: string; tool: TacoTool; fileAccess?: FileAccess }> {
        return [...this._tools];
    }

    toolCandidates(): ExtensionToolCandidateWithSource[] {
        return [...this._toolCandidates];
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

    sessionActivators(): SessionActivatorEntry[] {
        return [...this._sessionActivators];
    }

    /** Skill dirs contributed by enabled builtins, in registration order. */
    extensionSkillDirs(): readonly string[] {
        return [...this._extensionSkillDirs];
    }

    get report(): RegistryReport {
        return {
            loaded: [...this._report.loaded],
            failed: [...this._report.failed],
            unauthorized: [...this._report.unauthorized],
            disabled: [...this._report.disabled],
            disabledEntries: [...this._disabledEntries.values()],
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
    extensionConfig: Record<string, unknown> = {},
): Promise<void> {
    // Narrowed view handed to `manifest.register` — deliberately excludes
    // recordLoaded/recordFailed so a builtin cannot double-record itself;
    // the dispatcher below owns that bookkeeping exclusively.
    for (const manifest of manifests) {
        if (disabledExtensions.has(manifest.name)) {
            registry.recordDisabled(manifest.name, {
                version: manifest.version,
                source: "builtin",
                description: manifest.description,
                whenToUse: manifest.whenToUse,
                configSchema: manifest.configSchema,
            });
            continue;
        }

        const checkpoint = registry.checkpoint();
        try {
            const config = resolveExtensionConfig(
                manifest.name,
                extensionConfig,
                manifest.configSchema,
            );
            const builtinApi: BuiltinRegistryApi = {
                config,
                addSessionActivator: (source, extName, activator) =>
                    registry.addSessionActivator(source, extName, activator, config),
                addExtensionTag: (extName, name, spec) =>
                    registry.addExtensionTag(extName, name, spec),
                addWorkspaceActivator: (source, extName, activator) =>
                    registry.addWorkspaceActivator(source, extName, activator, config),
                addToolResultInterceptor: (source, hook) =>
                    registry.addToolResultInterceptor(source, hook, manifest.name),
            };
            if (manifest.register) {
                await manifest.register(builtinApi);
            }

            if (manifest.activator) {
                registry.addWorkspaceActivator(
                    "builtin",
                    manifest.name,
                    await manifest.activator(config),
                    config,
                );
            }

            // recordLoaded runs LAST, after register/activator succeed, so:
            //   - `extensionTagsFor` sees any tags the builtin just registered
            //     (register runs addExtensionTag before this point)
            //   - a throwing register/activator lands the entry in `failed`
            //     only, never both `loaded` and `failed`
            if (manifest.skillDirs) {
                const dirs =
                    typeof manifest.skillDirs === "function"
                        ? manifest.skillDirs(config)
                        : manifest.skillDirs;
                registry.addExtensionSkillDirs(dirs, manifest.name);
            }
            const tags = registry.extensionTagsFor(manifest.name);
            registry.recordLoaded({
                name: manifest.name,
                version: manifest.version,
                source: "builtin",
                permissions: [],
                configSchema: manifest.configSchema,
                description: manifest.description,
                whenToUse: manifest.whenToUse,
                ...(tags.length > 0 ? { tags } : {}),
            });
        } catch (e) {
            registry.rollback(checkpoint);
            registry.recordFailed(manifest.name, (e as Error).message);
        }
    }
}
