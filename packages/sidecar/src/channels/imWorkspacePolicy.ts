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
    type ImConversationEntry,
    type ImPolicyChatOverrideEntry,
    type ImRoute,
    type ImToolPolicy,
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
): CommandPermissionRule[] | undefined {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) invalid(source, `commands.${field}`, raw);
    const rules: CommandPermissionRule[] = [];
    for (const item of raw) {
        if (typeof item !== "string") invalid(source, `commands.${field}`, item);
        const check = validatePermissionRule(item);
        if (!check.valid) invalid(source, `commands.${field}`, check.reason);
        rules.push(check.canonical);
    }
    return rules;
}

export function validatePartial(raw: unknown, source: string): ImWorkspacePolicyPatch {
    if (raw === undefined) return {};
    if (!isRecord(raw)) invalid(source, "root", raw);

    let tools: Partial<ImToolPolicy> = {};
    if (raw.tools !== undefined) {
        if (!isRecord(raw.tools)) invalid(source, "tools", raw.tools);
        const t = raw.tools as Record<string, unknown>;
        if (
            t.fsTools !== undefined &&
            !(TOOL_VERDICTS as readonly string[]).includes(String(t.fsTools))
        )
            invalid(source, "tools.fsTools", t.fsTools);
        if (
            t.shell !== undefined &&
            !(TOOL_VERDICTS as readonly string[]).includes(String(t.shell))
        )
            invalid(source, "tools.shell", t.shell);
        tools = {
            ...(t.fsTools === undefined ? {} : { fsTools: t.fsTools as ImToolPolicy["fsTools"] }),
            ...(t.shell === undefined ? {} : { shell: t.shell as ImToolPolicy["shell"] }),
        };
    }

    let commands: Partial<ImCommandPolicy> = {};
    if (raw.commands !== undefined) {
        if (!isRecord(raw.commands)) invalid(source, "commands", raw.commands);
        const c = raw.commands as Record<string, unknown>;
        if (c.mode !== undefined && !COMMAND_PERMISSION_MODES.has(c.mode as CommandPermissionMode))
            invalid(source, "commands.mode", c.mode);
        commands = {
            ...(c.mode === undefined ? {} : { mode: c.mode as ImCommandPolicy["mode"] }),
            ...(c.allow === undefined
                ? {}
                : { allow: validateCommandRules(c.allow, source, "allow") }),
            ...(c.deny === undefined ? {} : { deny: validateCommandRules(c.deny, source, "deny") }),
        };
    }

    let binding: ImWorkspacePolicy["binding"];
    if (raw.binding !== undefined) {
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

    let perChatScratch: boolean | undefined;
    if (raw.perChatScratch !== undefined) {
        if (typeof raw.perChatScratch !== "boolean")
            invalid(source, "perChatScratch", raw.perChatScratch);
        perChatScratch = raw.perChatScratch;
    }

    const out: ImWorkspacePolicyPatch = {};
    if (Object.keys(tools).length > 0) out.tools = tools;
    if (Object.keys(commands).length > 0) out.commands = commands;
    if (binding) out.binding = binding;
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
    const tools = { ...base.tools, ...patch.tools };
    if (Object.keys(tools).length > 0) out.tools = tools;
    const commands = { ...base.commands, ...patch.commands };
    if (Object.keys(commands).length > 0) out.commands = commands;
    const binding = patch.binding ?? base.binding;
    if (binding !== undefined) out.binding = binding;
    const perChatScratch = patch.perChatScratch ?? base.perChatScratch;
    if (perChatScratch !== undefined) out.perChatScratch = perChatScratch;
    return out;
}

/** Deep-merge a patch over a base. `tools`/`commands` merge field-wise;
 *  `binding` and `perChatScratch` replace wholesale. */
export function mergeImWorkspacePolicy(
    base: ImWorkspacePolicy,
    patch: ImWorkspacePolicyPatch,
): ImWorkspacePolicy {
    return {
        tools: { ...base.tools, ...patch.tools },
        commands: { ...base.commands, ...patch.commands },
        ...(patch.binding !== undefined
            ? { binding: patch.binding }
            : base.binding !== undefined
              ? { binding: base.binding }
              : {}),
        ...(patch.perChatScratch !== undefined
            ? { perChatScratch: patch.perChatScratch }
            : base.perChatScratch !== undefined
              ? { perChatScratch: base.perChatScratch }
              : {}),
    };
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
