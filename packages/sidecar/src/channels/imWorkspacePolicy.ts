/**
 * Per-(channel, chat) workspace policy for IM workspaces.
 *
 * The current `disableFsTools = true` blanket is replaced by a two-level
 * policy — channel default + per-chat override — resolved by route. All
 * dimensions default to deny; only explicit admin configuration relaxes
 * them. See docs/superpowers/specs/2026-08-09-im-channel-capabilities-design.md.
 *
 * The pure-data types (`ImRoute`, `ImWorkspacePolicy`, …) live in
 * `@taco-ai/protocol` so both sidecar and desktop share them; this file
 * owns the merge / validation / hashing logic that depends on Node APIs.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import {
    COMMAND_PERMISSION_MODES,
    type CommandPermissionMode,
    type CommandPermissionRule,
    type ImCommandPolicy,
    type ImCommandPolicyPatch,
    type ImConversationEntry,
    type ImExecutionDir,
    type ImExecutionDirMode,
    type ImPolicyChatOverrideEntry,
    type ImPolicyField,
    type ImPolicyRuleGroup,
    type ImPolicyRulesView,
    type ImPolicySource,
    type ImPolicySources,
    type ImRoute,
    type ImToolPolicy,
    type ImToolPolicyPatch,
    type ImWorkspacePolicy,
    type ImWorkspacePolicyDocument,
    type ImWorkspacePolicyPatch,
    makeImCwd,
} from "@taco-ai/protocol";
import { createLogger } from "../lib/logger.ts";
import { validatePermissionRule } from "../permissions/shellRuleMatching.ts";

// Re-export the wire types so existing sidecar imports
// (`import type { ImWorkspacePolicy } from "../channels/imWorkspacePolicy.ts"`)
// keep compiling without touching every call site.
export type {
    ImCommandPolicy,
    ImPolicyChatOverrideEntry,
    ImRoute,
    ImToolPolicy,
    ImWorkspacePolicy,
    ImWorkspacePolicyDocument,
    ImWorkspacePolicyPatch,
} from "@taco-ai/protocol";

const log = createLogger("channel:im-policy");

export const DEFAULT_IM_WORKSPACE_POLICY: ImWorkspacePolicy = {
    tools: { fsTools: "deny", shell: "deny" },
    commands: { mode: "ask" },
    executionDir: { mode: "shared" },
};

const TOOL_VERDICTS = ["deny", "allow"] as const;
const EXECUTION_DIR_MODES: ReadonlySet<ImExecutionDirMode> = new Set([
    "shared",
    "per-chat",
    "custom",
]);

/** Stable full-length sha256 over the wire-format route key. No truncation,
 *  so no collision-disambiguation branch is needed. */
export function chatPolicyKey(route: ImRoute): string {
    return createHash("sha256")
        .update(makeImCwd(route.channelId, route.peerId, route.chatId))
        .digest("hex");
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function invalid(source: string, field: string, detail: unknown): never {
    throw new Error(`invalid im policy ${field} from ${source}: ${String(detail)}`);
}

function validateCommandRules(
    raw: unknown,
    source: string,
    field: "allow" | "deny",
): CommandPermissionRule[] | null | undefined {
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    if (!Array.isArray(raw)) invalid(source, `commands.${field}`, raw);
    const rules: CommandPermissionRule[] = [];
    for (const item of raw) {
        if (typeof item !== "string") invalid(source, `commands.${field}`, item);
        const check = validatePermissionRule(item, { allowShellWrapper: field === "deny" });
        if (!check.valid) invalid(source, `commands.${field}`, check.reason);
        rules.push(check.canonical);
    }
    return rules;
}

export function validatePartial(raw: unknown, source: string): ImWorkspacePolicyPatch {
    if (raw === undefined) return {};
    if (!isRecord(raw)) invalid(source, "root", raw);

    let tools: ImToolPolicyPatch = {};
    if (raw.tools !== undefined) {
        if (!isRecord(raw.tools)) invalid(source, "tools", raw.tools);
        const t = raw.tools as Record<string, unknown>;
        const verdict = (
            field: "fsTools" | "shell",
        ): ImToolPolicy["fsTools"] | null | undefined => {
            const value = t[field];
            if (value === undefined) return undefined;
            if (value === null) return null;
            if (!(TOOL_VERDICTS as readonly string[]).includes(String(value)))
                invalid(source, `tools.${field}`, value);
            return value as ImToolPolicy["fsTools"];
        };
        const fsTools = verdict("fsTools");
        const shell = verdict("shell");
        tools = {
            ...(fsTools === undefined ? {} : { fsTools }),
            ...(shell === undefined ? {} : { shell }),
        };
    }

    let commands: ImCommandPolicyPatch = {};
    if (raw.commands !== undefined) {
        if (!isRecord(raw.commands)) invalid(source, "commands", raw.commands);
        const c = raw.commands as Record<string, unknown>;
        if (
            c.mode !== undefined &&
            c.mode !== null &&
            !COMMAND_PERMISSION_MODES.has(c.mode as CommandPermissionMode)
        )
            invalid(source, "commands.mode", c.mode);
        commands = {
            ...(c.mode === undefined ? {} : { mode: c.mode as ImCommandPolicy["mode"] | null }),
            ...(c.allow === undefined
                ? {}
                : { allow: validateCommandRules(c.allow, source, "allow") }),
            ...(c.deny === undefined ? {} : { deny: validateCommandRules(c.deny, source, "deny") }),
        };
    }

    let executionDir: ImExecutionDir | null | undefined;
    if (raw.executionDir === null) {
        executionDir = null;
    } else if (raw.executionDir !== undefined) {
        if (!isRecord(raw.executionDir)) invalid(source, "executionDir", raw.executionDir);
        const mode = (raw.executionDir as Record<string, unknown>).mode;
        if (!EXECUTION_DIR_MODES.has(mode as ImExecutionDirMode))
            invalid(source, "executionDir.mode", mode);
        const dirPath = (raw.executionDir as Record<string, unknown>).path;
        if (mode === "custom") {
            if (typeof dirPath !== "string" || !path.isAbsolute(dirPath))
                invalid(
                    source,
                    "executionDir.path",
                    `expected absolute path, got ${JSON.stringify(dirPath)}`,
                );
            executionDir = { mode: "custom", path: dirPath };
        } else {
            executionDir = { mode: mode as ImExecutionDirMode };
        }
    }

    let binding: { executionCwd: string } | null | undefined;
    if (raw.binding === null) {
        binding = null;
    } else if (raw.binding !== undefined) {
        if (!isRecord(raw.binding)) invalid(source, "binding", raw.binding);
        const executionCwd = (raw.binding as Record<string, unknown>).executionCwd;
        if (typeof executionCwd !== "string" || !path.isAbsolute(executionCwd))
            invalid(
                source,
                "binding.executionCwd",
                `expected absolute path, got ${JSON.stringify(executionCwd)}`,
            );
        binding = { executionCwd };
    }

    let perChatScratch: boolean | null | undefined;
    if (raw.perChatScratch === null) {
        perChatScratch = null;
    } else if (raw.perChatScratch !== undefined) {
        if (typeof raw.perChatScratch !== "boolean")
            invalid(source, "perChatScratch", raw.perChatScratch);
        perChatScratch = raw.perChatScratch;
    }

    const out: ImWorkspacePolicyPatch = {};
    if (Object.keys(tools).length > 0) out.tools = tools;
    if (Object.keys(commands).length > 0) out.commands = commands;
    if (executionDir !== undefined) out.executionDir = executionDir;
    if (binding !== undefined) out.binding = binding;
    if (perChatScratch !== undefined) out.perChatScratch = perChatScratch;
    return out;
}

/** Strict validator — throws on invalid input. Absent fields are filled from defaults. */
export function validateImWorkspacePolicy(raw: unknown, source: string): ImWorkspacePolicy {
    const partial = validatePartial(raw, source);
    return mergeImWorkspacePolicy(DEFAULT_IM_WORKSPACE_POLICY, partial);
}

/**
 * Merge one patch over another, preserving fields the new patch does not
 * mention. Used by the store's setters so editing one field does not silently
 * revoke unrelated grants. `tools`/`commands` merge field-wise; `binding` and
 * `perChatScratch` replace wholesale when present.
 */
export function mergeImWorkspacePolicyPatch(
    base: ImWorkspacePolicyPatch,
    patch: ImWorkspacePolicyPatch,
): ImWorkspacePolicyPatch {
    const out: ImWorkspacePolicyPatch = {};
    const tools: ImToolPolicyPatch = { ...base.tools };
    for (const field of ["fsTools", "shell"] as const) {
        const value = patch.tools?.[field];
        if (value === undefined) continue;
        if (value === null) delete tools[field];
        else tools[field] = value;
    }
    if (Object.keys(tools).length > 0) out.tools = tools;

    const commands: ImCommandPolicyPatch = { ...base.commands };
    if (patch.commands?.mode !== undefined) {
        if (patch.commands.mode === null) delete commands.mode;
        else commands.mode = patch.commands.mode;
    }
    for (const field of ["allow", "deny"] as const) {
        const value = patch.commands?.[field];
        if (value === undefined) continue;
        if (value === null) delete commands[field];
        else commands[field] = value;
    }
    if (Object.keys(commands).length > 0) out.commands = commands;

    // The canonical field supersedes the legacy pair: writing it replaces the
    // layer's working-directory choice outright, clearing it hands the choice
    // back to the parent layer.
    if (patch.executionDir !== undefined) {
        if (patch.executionDir !== null) out.executionDir = patch.executionDir;
    } else if (base.executionDir !== undefined) {
        out.executionDir = base.executionDir;
    }

    if (patch.executionDir === undefined) {
        if (patch.binding === null) {
            // clear
        } else if (patch.binding !== undefined) {
            out.binding = patch.binding;
        } else if (base.binding !== undefined) {
            out.binding = base.binding;
        }

        const perChatScratch =
            patch.perChatScratch === null
                ? undefined
                : patch.perChatScratch !== undefined
                  ? patch.perChatScratch
                  : base.perChatScratch;
        if (perChatScratch !== undefined) out.perChatScratch = perChatScratch;
    }

    return out;
}

/** Deep-merge a patch over a base. `tools`/`commands` merge field-wise;
 *  `binding` and `perChatScratch` replace wholesale. */
export function mergeImWorkspacePolicy(
    base: ImWorkspacePolicy,
    patch: ImWorkspacePolicyPatch,
): ImWorkspacePolicy {
    const allow = dedupeRules([...(base.commands.allow ?? []), ...(patch.commands?.allow ?? [])]);
    const deny = dedupeRules([...(base.commands.deny ?? []), ...(patch.commands?.deny ?? [])]);
    const fsTools =
        patch.tools?.fsTools === undefined || patch.tools.fsTools === null
            ? base.tools.fsTools
            : patch.tools.fsTools;
    const shell =
        patch.tools?.shell === undefined || patch.tools.shell === null
            ? base.tools.shell
            : patch.tools.shell;
    const mode =
        patch.commands?.mode === undefined || patch.commands.mode === null
            ? base.commands.mode
            : patch.commands.mode;
    return {
        tools: { fsTools, shell },
        commands: {
            mode,
            ...(allow.length > 0 ? { allow } : {}),
            ...(deny.length > 0 ? { deny } : {}),
        },
        executionDir:
            patch.executionDir !== undefined && patch.executionDir !== null
                ? patch.executionDir
                : base.executionDir,
    };
}

/**
 * The working directory a single layer asks for, ignoring the parent.
 *
 * The canonical `executionDir` wins. The legacy `binding` / `perChatScratch`
 * pair is only consulted for policy files written before the merge, and
 * `binding` still outranks `perChatScratch` there because that is how those
 * files behaved.
 */
function deriveLayerExecutionDir(
    patch: ImWorkspacePolicyPatch,
): { value: ImExecutionDir; explicit: boolean } | undefined {
    if (patch.executionDir !== undefined && patch.executionDir !== null) {
        return { value: patch.executionDir, explicit: true };
    }
    if (patch.binding && path.isAbsolute(patch.binding.executionCwd)) {
        return { value: { mode: "custom", path: patch.binding.executionCwd }, explicit: false };
    }
    if (patch.perChatScratch === true) return { value: { mode: "per-chat" }, explicit: false };
    if (patch.perChatScratch === false) return { value: { mode: "shared" }, explicit: false };
    return undefined;
}

/**
 * Resolve the working directory for one layer.
 *
 * `parent` carries the value and the layer that produced it. A legacy
 * `perChatScratch` on a child layer is inert when an ancestor already pinned
 * a custom directory — that was the old runtime rule, and keeping it means
 * existing policy files keep behaving exactly as before.
 */
function resolveLayerExecutionDir(
    patch: ImWorkspacePolicyPatch,
    parent: { value: ImExecutionDir; source: ImPolicySource },
    source: ImPolicySource,
): { value: ImExecutionDir; source: ImPolicySource } {
    const derived = deriveLayerExecutionDir(patch);
    if (!derived) return parent;
    if (!derived.explicit && parent.value.mode === "custom" && derived.value.mode !== "custom") {
        return parent;
    }
    return { value: derived.value, source };
}

function dedupeRules(rules: readonly CommandPermissionRule[]): CommandPermissionRule[] {
    return Array.from(new Set(rules));
}

/**
 * Merge the layers of a policy document (DEFAULT → channel default → chat
 * override). Fail-closed per layer: a corrupt chat override must not erase a
 * valid channel default and vice versa, so each layer is validated inside its
 * own try/catch that logs and continues with the parent layer. `route === null`
 * skips the chat layer (used for channel-wide renders where no synthetic route
 * exists — chatPolicyKey throws on empty peerId/chatId).
 */
function mergeDocumentLayers(raw: unknown, route: ImRoute | null): ImWorkspacePolicy {
    if (!isRecord(raw)) {
        if (raw !== undefined && raw !== null)
            log.warn("im policy document is not an object, using defaults");
        return { ...DEFAULT_IM_WORKSPACE_POLICY };
    }
    const doc = raw as ImWorkspacePolicyDocument;
    let policy = DEFAULT_IM_WORKSPACE_POLICY;
    let dir: { value: ImExecutionDir; source: ImPolicySource } = {
        value: DEFAULT_IM_WORKSPACE_POLICY.executionDir,
        source: "default",
    };
    if (doc.default !== undefined) {
        try {
            const patch = validatePartial(doc.default, "channel-default");
            dir = resolveLayerExecutionDir(patch, dir, "channel");
            policy = mergeImWorkspacePolicy(policy, { ...patch, executionDir: dir.value });
        } catch (e) {
            log.warn(
                `im policy channel-default invalid ${route ? `for ${route.channelId}` : ""}, using DEFAULT for this layer: ${e}`,
            );
        }
    }
    if (route !== null) {
        const chatOverride = doc.chats?.[chatPolicyKey(route)];
        if (chatOverride !== undefined) {
            try {
                const patch = validatePartial(chatOverride, "chat-override");
                const chatDir = resolveLayerExecutionDir(patch, dir, "chat");
                policy = mergeImWorkspacePolicy(policy, { ...patch, executionDir: chatDir.value });
            } catch (e) {
                log.warn(
                    `im policy chat-override invalid for ${route.channelId}/${route.chatId}, using parent layer only: ${e}`,
                );
            }
        }
    }
    return policy;
}

interface PolicyLayerPatches {
    channel: ImWorkspacePolicyPatch;
    chat: ImWorkspacePolicyPatch | null;
}

/**
 * Read the raw channel/chat patches for display purposes. Each layer is
 * validated independently: a corrupt layer is ignored instead of blanking
 * the whole panel, matching the resolver's fail-closed behaviour.
 */
function readPolicyLayers(raw: unknown, route: ImRoute | null): PolicyLayerPatches {
    if (!isRecord(raw)) return { channel: {}, chat: route ? {} : null };
    const doc = raw as ImWorkspacePolicyDocument;
    const label = route ? `${route.channelId}/${route.chatId}` : "channel";

    let channel: ImWorkspacePolicyPatch = {};
    if (doc.default !== undefined) {
        try {
            channel = validatePartial(doc.default, `channel-default:${label}`);
        } catch (e) {
            log.warn(`im policy channel-default invalid while describing ${label}: ${String(e)}`);
        }
    }

    let chat: ImWorkspacePolicyPatch | null = route ? {} : null;
    if (route) {
        const rawChat = doc.chats?.[chatPolicyKey(route)];
        if (rawChat !== undefined) {
            try {
                chat = validatePartial(rawChat, `chat-override:${label}`);
            } catch (e) {
                log.warn(`im policy chat-override invalid while describing ${label}: ${String(e)}`);
            }
        }
    }
    return { channel, chat };
}

/**
 * Report where each resolved single-value field came from. `route === null`
 * describes the channel scope; otherwise the chat override wins, then the
 * channel default, then the built-in default.
 */
export function describeImPolicySources(raw: unknown, route: ImRoute | null): ImPolicySources {
    const { channel, chat } = readPolicyLayers(raw, route);
    // `inherited` is the value one layer up from the scope being described:
    // the built-in default for the channel scope, the channel result for a chat.
    const pick = <T>(
        chatValue: T | null | undefined,
        channelValue: T | null | undefined,
        fallback: T,
    ): ImPolicyField<T> => {
        const fromDefault = { value: fallback, source: "default" as const };
        const fromChannel =
            channelValue !== undefined && channelValue !== null
                ? { value: channelValue, source: "channel" as const }
                : fromDefault;
        const inherited = route === null ? fromDefault : fromChannel;
        if (chatValue !== undefined && chatValue !== null)
            return { value: chatValue, source: "chat", inherited };
        return { ...fromChannel, inherited };
    };

    const defaultDir = {
        value: DEFAULT_IM_WORKSPACE_POLICY.executionDir,
        source: "default" as const,
    };
    const channelDir = resolveLayerExecutionDir(channel, defaultDir, "channel");
    const dir = resolveExecutionDirChain(channel, chat);

    return {
        fsTools: pick(chat?.tools?.fsTools, channel.tools?.fsTools, "deny"),
        shell: pick(chat?.tools?.shell, channel.tools?.shell, "deny"),
        commandMode: pick(chat?.commands?.mode, channel.commands?.mode, "ask"),
        executionDir: {
            value: dir.value,
            source: dir.source,
            inherited: route === null ? defaultDir : channelDir,
        },
    };
}

/**
 * Walk the channel and chat layers and decide which one owns the working
 * directory. The chat layer wins when it sets the field; a legacy
 * `perChatScratch` there stays inert when the channel already pinned a
 * custom directory.
 */
function resolveExecutionDirChain(
    channel: ImWorkspacePolicyPatch,
    chat: ImWorkspacePolicyPatch | null,
): { value: ImExecutionDir; source: ImPolicySource } {
    let dir = resolveLayerExecutionDir(
        channel,
        { value: DEFAULT_IM_WORKSPACE_POLICY.executionDir, source: "default" },
        "channel",
    );
    if (chat) {
        dir = resolveLayerExecutionDir(chat, dir, "chat");
    }
    return dir;
}

/**
 * Group allow/deny rules by the layer that contributed them. Inherited
 * groups are read-only; the current scope's group is the only editable one.
 */
export function describeImPolicyRules(
    raw: unknown,
    route: ImRoute | null,
    globalRules: {
        allow?: readonly CommandPermissionRule[];
        deny?: readonly CommandPermissionRule[];
    } = {},
): ImPolicyRulesView {
    const { channel, chat } = readPolicyLayers(raw, route);
    const groups = (field: "allow" | "deny"): ImPolicyRuleGroup[] => {
        const out: ImPolicyRuleGroup[] = [];
        const globalList = [...(globalRules[field] ?? [])];
        if (globalList.length > 0)
            out.push({ source: "global", rules: globalList, editable: false });

        const channelList = [...(channel.commands?.[field] ?? [])];
        if (route === null) {
            out.push({ source: "channel", rules: channelList, editable: true });
        } else if (channelList.length > 0) {
            out.push({ source: "channel", rules: channelList, editable: false });
        }

        if (route !== null) {
            out.push({
                source: "chat",
                rules: [...(chat?.commands?.[field] ?? [])],
                editable: true,
            });
        }
        return out;
    };
    return { allow: groups("allow"), deny: groups("deny") };
}

/**
 * Rewrite a policy document into the canonical shape: every layer's working
 * directory becomes a single `executionDir`, and the legacy `binding` /
 * `perChatScratch` fields are dropped.
 *
 * A legacy `perChatScratch` on a chat layer is dropped without a replacement
 * when the channel already pinned a custom directory — that combination was
 * inert under the old runtime rules, and turning it into an explicit choice
 * would silently move where that chat's tools run.
 */
export function normalizePolicyDocument(raw: unknown): ImWorkspacePolicyDocument {
    if (!isRecord(raw)) return {};
    const doc = raw as ImWorkspacePolicyDocument;
    const out: ImWorkspacePolicyDocument = {};

    const channel = normalizeLayerPatch(doc.default);
    if (channel !== undefined) out.default = channel;

    let channelDir: { value: ImExecutionDir; source: ImPolicySource } = {
        value: DEFAULT_IM_WORKSPACE_POLICY.executionDir,
        source: "default",
    };
    if (doc.default !== undefined) {
        const patch = safeValidatePartial(doc.default, "channel-default");
        if (patch) {
            channelDir = resolveLayerExecutionDir(patch, channelDir, "channel");
        }
    }

    const chats: Record<string, ImWorkspacePolicyPatch> = {};
    for (const [key, rawPatch] of Object.entries(doc.chats ?? {})) {
        const normalized = normalizeLayerPatch(rawPatch, channelDir);
        if (normalized !== undefined) chats[key] = normalized;
    }
    if (Object.keys(chats).length > 0) out.chats = chats;
    return out;
}

function normalizeLayerPatch(
    raw: unknown,
    ancestorDir?: { value: ImExecutionDir; source: ImPolicySource },
): ImWorkspacePolicyPatch | undefined {
    if (!isRecord(raw)) return undefined;
    const patch = safeValidatePartial(raw, "normalize");
    if (!patch) return undefined;

    const out: ImWorkspacePolicyPatch = { ...patch };
    if (patch.executionDir === undefined) {
        const derived = deriveLayerExecutionDir(patch);
        if (derived) {
            const inert =
                !derived.explicit &&
                ancestorDir?.value.mode === "custom" &&
                derived.value.mode !== "custom";
            if (!inert) out.executionDir = derived.value;
        }
    } else if (patch.executionDir === null) {
        // "cleared at this layer" and "not set at this layer" mean the same
        // thing once stored, so keep only the absent form.
        delete out.executionDir;
    }
    delete out.binding;
    delete out.perChatScratch;
    return out;
}

export const IM_POLICY_DOCUMENT_VERSION = 2 as const;

/**
 * Before 0.2.11 IM `auto` only auto-passed strict read-only commands (and,
 * with an `allow` list, refused everything outside it). `auto` now allows
 * every command outside the deny lists, so reading an old file verbatim
 * would silently widen it. Every `auto` layer becomes `ask` instead; allow
 * lists keep auto-passing, and chat layers that inherited `auto` now inherit
 * the migrated `ask`.
 */
export function migrateLegacyImPolicyDocument(
    doc: ImWorkspacePolicyDocument,
): ImWorkspacePolicyDocument {
    if (doc.version !== undefined) return doc;
    const migrate = (layer: ImWorkspacePolicyPatch): ImWorkspacePolicyPatch =>
        isRecord(layer) && isRecord(layer.commands) && layer.commands.mode === "auto"
            ? { ...layer, commands: { ...layer.commands, mode: "ask" } }
            : layer;
    const out: ImWorkspacePolicyDocument = { ...doc };
    if (doc.default) out.default = migrate(doc.default);
    if (doc.chats) {
        out.chats = Object.fromEntries(
            Object.entries(doc.chats).map(([key, layer]) => [key, migrate(layer)]),
        );
    }
    return out;
}

function safeValidatePartial(raw: unknown, source: string): ImWorkspacePolicyPatch | undefined {
    try {
        return validatePartial(raw, source);
    } catch (e) {
        log.warn(`im policy layer invalid while normalizing (${source}): ${String(e)}`);
        return undefined;
    }
}

/**
 * Resolve the effective policy for a route: DEFAULT → channel default → chat
 * override. Fail-closed: any corrupt input logs a warning and yields a frozen
 * copy of the defaults; never rethrows.
 */
export function resolveImWorkspacePolicyFromDocument(
    raw: unknown,
    route: ImRoute,
): ImWorkspacePolicy {
    return mergeDocumentLayers(raw, route);
}

/**
 * Channel-level two-layer resolve: DEFAULT + channel default. Skips the chat
 * layer so callers can render the channel-wide effective policy without
 * needing a synthetic route (chatPolicyKey throws on empty peerId/chatId).
 * Fail-closed per layer, same as `resolveImWorkspacePolicyFromDocument`.
 */
export function resolveChannelDefaultFromDocument(raw: unknown): ImWorkspacePolicy {
    return mergeDocumentLayers(raw, null);
}

/**
 * Join the stored chats-map (keyed by sha256) against the live conversation
 * list. Returns every override; entries whose key matches a live
 * conversation additionally carry `route`. Entries with no live match are
 * orphans — the editor still lists them so admins can clear stale grants.
 * Routes whose channelId differs from the requested channel are ignored.
 */
export function describeImChatOverrides(
    raw: unknown,
    channelId: string,
    conversations: readonly ImConversationEntry[],
): ImPolicyChatOverrideEntry[] {
    if (!isRecord(raw)) return [];
    const doc = raw as ImWorkspacePolicyDocument;
    const chats = doc.chats ?? {};
    const byKey = new Map<string, ImRoute>();
    for (const c of conversations) {
        if (c.channelId !== channelId) continue;
        byKey.set(chatPolicyKey({ channelId, peerId: c.peerId, chatId: c.chatId }), {
            channelId,
            peerId: c.peerId,
            chatId: c.chatId,
        });
    }
    const entries: ImPolicyChatOverrideEntry[] = [];
    for (const [key, patch] of Object.entries(chats)) {
        const route = byKey.get(key);
        entries.push({
            key,
            ...(route ? { route } : {}),
            patch,
        });
    }
    return entries;
}
