/**
 * configGet / configPatch — read and change the global taco configuration.
 *
 * Both are DEFERRED: they are registered as tool candidates and loaded on
 * demand via `addTools`, so their schema and description cost nothing in the
 * per-request tools JSON. Most sessions never touch the global config, and
 * the ones that do are rare enough that a listing in `<deferred_tools>` is a
 * better trade than a resident tool.
 *
 * `configGet` reads through `settings.get`, which masks every secret (API
 * keys, MCP env/headers, channel credentials). The model never sees
 * plaintext key material.
 *
 * `configPatch` goes through `config.patch`, which asks the user BEFORE
 * writing. The approval lives in the handler, not here: a config change can
 * disable the very approvals that would review it, so the write must not be
 * reachable without one. A tool that approved and then wrote separately
 * would leave a gap between the two.
 *
 * BOUNDARY. These tools exist only in a LOCAL MAIN SESSION. An IM
 * conversation is driven by a third party, and a subagent runs without the
 * user watching — neither may rewrite the global config. The check is here
 * (so the model gets a clear reason) AND in the handler (so the boundary
 * holds even if something else reaches the RPC).
 */

import type {
    CommandPermissionDenialReason,
    GlobalConfigPatch,
    TacoGlobalConfigView,
} from "@taco-ai/protocol";
import { asToolCallId, RPC } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import { denialGuidance } from "../permissions/denialGuidance.ts";
import type { TacoToolContext } from "./context.ts";
import type { TacoTool } from "./index.ts";

const configGetSchema = Type.Object({});

const configPatchSchema = Type.Object({
    patch: Type.Object(
        {
            defaultModel: Type.Optional(Type.String()),
            defaultProvider: Type.Optional(Type.String()),
            thinkingLevel: Type.Optional(
                Type.Union([
                    Type.Literal("off"),
                    Type.Literal("minimal"),
                    Type.Literal("low"),
                    Type.Literal("medium"),
                    Type.Literal("high"),
                    Type.Literal("xhigh"),
                ]),
            ),
            systemPrompt: Type.Optional(Type.String()),
            compaction: Type.Optional(
                Type.Object({
                    enabled: Type.Optional(Type.Boolean()),
                    threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
                }),
            ),
            instructions: Type.Optional(
                Type.Object({
                    enabled: Type.Optional(Type.Boolean()),
                    files: Type.Optional(
                        Type.Object({
                            claudeMd: Type.Optional(Type.Boolean()),
                            agentsMd: Type.Optional(Type.Boolean()),
                            designMd: Type.Optional(Type.Boolean()),
                        }),
                    ),
                    inheritToSubagents: Type.Optional(Type.Boolean()),
                }),
            ),
            commandPermissions: Type.Optional(
                Type.Object({
                    mode: Type.Optional(Type.Union([Type.Literal("ask"), Type.Literal("auto")])),
                    allow: Type.Optional(Type.Array(Type.String())),
                    deny: Type.Optional(Type.Array(Type.String())),
                }),
            ),
        },
        {
            description:
                "Config fields to change. Only the fields you list are touched; " +
                "everything else keeps its current value. The allow/deny arrays are " +
                "REPLACED wholesale, not merged — send the full list you want.",
        },
    ),
});

export type ConfigGetToolInput = Static<typeof configGetSchema>;
export type ConfigPatchToolInput = Static<typeof configPatchSchema>;

/** The config fields a patch touches — shown on the approval prompt. */
export function patchFields(patch: GlobalConfigPatch): string[] {
    return Object.keys(patch).filter((key) => patch[key as keyof GlobalConfigPatch] !== undefined);
}

/**
 * Render the masked config for the model.
 *
 * The MCP server list and the channel list are dropped: the model cannot
 * change them (their env/headers/credentials are masked, so a partial
 * write would wipe secrets it never saw), and they only add noise.
 */
function summarizeConfig(view: TacoGlobalConfigView): string {
    const { mcpServers: _mcpServers, channels: _channels, ...rest } = view;
    return JSON.stringify(rest, null, 2);
}

/**
 * True when this session may use the config tools.
 *
 * IM conversations are driven by a third party, and a subagent runs without
 * the user watching. Neither may rewrite the global config.
 */
export function configToolsAllowed(ctx: TacoToolContext): boolean {
    return ctx.sessionKind === "main" && !ctx.isIm;
}

const REFUSAL =
    "The config tools are not available in this session. They change global taco " +
    "settings, which only a local desktop session may do.";

function createConfigGet(): TacoTool {
    return {
        name: "configGet",
        label: "configGet",
        description:
            "Read the global taco configuration (default model, thinking level, system " +
            "prompt, command permissions). Secrets are masked and cannot be read back. " +
            "Use this before changing a setting, to see its current value.",
        parameters: configGetSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Read the current global taco configuration. Secrets come back masked, so a " +
                "stored key can only be confirmed as present, never shown.",
            mutates: false,
        },
        async execute(
            _toolCallId: string,
            _params: ConfigGetToolInput,
            _onUpdate: unknown,
            ctx: TacoToolContext,
        ): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
            if (!configToolsAllowed(ctx)) throw new Error(REFUSAL);
            if (!ctx.call) {
                throw new Error("configGet: no self-RPC dispatcher in this workspace");
            }
            const result = await ctx.call(RPC.settingsGet, ctx.workspace, undefined);
            return {
                content: [{ type: "text", text: summarizeConfig(result.global) }],
                details: result.global,
            };
        },
    };
}

/**
 * The guidance for a change that was not approved.
 *
 * Shared with every other tool that goes through the permission broker (see
 * `permissions/denialGuidance.ts`). The wording names the routes to the
 * same outcome, because a model otherwise reads a denial as "use a different
 * tool" and goes and edits `taco.json` by hand — or splits the change
 * across two patches so each looks smaller than the one that was refused.
 */
function denialText(reason: CommandPermissionDenialReason | undefined): string {
    return denialGuidance(reason, {
        action: "the configuration change",
        alternativeRoutes:
            "editing taco.json directly, or splitting the change into smaller patches so each " +
            "looks less consequential",
    });
}

function createConfigPatch(): TacoTool {
    return {
        name: "configPatch",
        label: "configPatch",
        description:
            "Change the global taco configuration. The user is asked to approve each change " +
            "before it is written. API keys, MCP servers and channels cannot be set here — " +
            "the desktop settings pane is the only way to enter them.",
        parameters: configPatchSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Change global taco settings (default model, thinking level, system prompt, " +
                "command permissions). Each change is approved by the user first.",
            mutates: true,
        },
        async execute(
            toolCallId: string,
            params: ConfigPatchToolInput,
            _onUpdate: unknown,
            ctx: TacoToolContext,
        ): Promise<{
            content: { type: "text"; text: string }[];
            details: unknown;
            isError?: boolean;
        }> {
            if (!configToolsAllowed(ctx)) throw new Error(REFUSAL);
            if (!ctx.call) {
                throw new Error("configPatch: no self-RPC dispatcher in this workspace");
            }
            const patch = params.patch as GlobalConfigPatch;
            const result = await ctx.call(RPC.configPatch, ctx.workspace, {
                workspace: ctx.workspace,
                sessionId: ctx.sessionId,
                toolCallId: asToolCallId(toolCallId),
                patch,
            });
            if (!result.approved) {
                return {
                    content: [{ type: "text", text: denialText(result.denialReason) }],
                    details: result,
                    // Marked as an error so the model treats it as a failed
                    // action, not a normal return it can build on.
                    isError: true,
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `Configuration updated.\n\n${summarizeConfig(result.global ?? {})}`,
                    },
                ],
                details: result,
            };
        },
    };
}

/** The two config tools, in the order they are meant to be used. */
export function createConfigTools(): { configGet: TacoTool; configPatch: TacoTool } {
    return { configGet: createConfigGet(), configPatch: createConfigPatch() };
}
