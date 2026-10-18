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
    type ImPolicyChatOverrideEntry,
    type ImPolicyField,
    type ImPolicyRuleGroup,
    type ImPolicyRulesView,
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
};

const TOOL_VERDICTS = ["deny", "allow"] as const;

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

    let binding: ImWorkspacePolicy["binding"] | null;
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
        ...(patch.binding !== undefined && patch.binding !== null
            ? { binding: patch.binding }
            : base.binding !== undefined
              ? { binding: base.binding }
              : {}),
        ...(patch.perChatScratch !== undefined && patch.perChatScratch !== null
            ? { perChatScratch: patch.perChatScratch }
            : base.perChatScratch !== undefined
              ? { perChatScratch: base.perChatScratch }
              : {}),
    };
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
    if (doc.default !== undefined) {
        try {
            policy = mergeImWorkspacePolicy(
                policy,
                validatePartial(doc.default, "channel-default"),
            );
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
                policy = mergeImWorkspacePolicy(
                    policy,
                    validatePartial(chatOverride, "chat-override"),
                );
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
    const pick = <T>(
        chatValue: T | null | undefined,
        channelValue: T | null | undefined,
        fallback: T,
    ): ImPolicyField<T> => {
        if (chatValue !== undefined && chatValue !== null)
            return { value: chatValue, source: "chat" };
        if (channelValue !== undefined && channelValue !== null)
            return { value: channelValue, source: "channel" };
        return { value: fallback, source: "default" };
    };

    return {
        fsTools: pick(chat?.tools?.fsTools, channel.tools?.fsTools, "deny"),
        shell: pick(chat?.tools?.shell, channel.tools?.shell, "deny"),
        commandMode: pick(chat?.commands?.mode, channel.commands?.mode, "ask"),
        perChatScratch: pick(chat?.perChatScratch, channel.perChatScratch, false),
        executionCwd: pick(chat?.binding?.executionCwd, channel.binding?.executionCwd, undefined),
    };
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
