/**
 * Register TACO's built-in tools.
 *
 *  - read / write / edit   — pi builtins
 *  - grep / glob           — context-aware search
 *  - shell                 — context-aware shell (platform-conditional)
 *  - agent / Skill         — per-session; main-session only
 *
 * The shared `TacoToolContext` (`tools/context.ts`) is injected by the
 * harness via `toolContext` and read by every tool that needs per-turn
 * state (workspace, call, actor). Tools no longer take constructor deps —
 * adding a new tool is a single-file change with no caller signature updates.
 */

import type { SessionId } from "@taco-ai/protocol";
import { commandOnPath } from "../lib/commandOnPath.ts";
import type { PermissionBroker } from "../permissions/permissionBroker.ts";
import type { PlanModeState } from "../plan/planModeState.ts";
import type { PlanSnapshotPublisher } from "../plan/planPushAdapter.ts";
import type { AgentHarnessTool } from "../runtime/pi/types.ts";
import { createEditTool, createReadTool, createWriteTool } from "../runtime/pi/values.ts";
import type { TaskSnapshotPublisher } from "../tasks/taskPushAdapter.ts";
import type { TaskStore } from "../tasks/taskTypes.ts";
import { createAskUserTool } from "./askUser.ts";
import { binaryReadHint } from "./binaryRead.ts";
import type { TacoToolContext } from "./context.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createJobsTools } from "./jobs.ts";
import { createMemoryTool } from "./memory.ts";
import { readPdf, readPdfBytes } from "./pdfIntercept.ts";
import { createPdfTools } from "./pdfTools.ts";
import { createPlanEnterTool } from "./planEnter.ts";
import { createPlanExitTool } from "./planExit.ts";
import { createShellTool } from "./shellTool.ts";
import { createTaskCreateTool } from "./taskCreate.ts";
import { createTaskListTool } from "./taskList.ts";
import { createTaskUpdateTool } from "./taskUpdate.ts";
import { createTodoWriteTool } from "./todoWrite.ts";
import { orderTools } from "./toolOrder.ts";

export type TacoTool = AgentHarnessTool<TacoToolContext>;

/**
 * Metadata the system-prompt builder reads off each tool. Optional — tools
 * that omit `promptSummary` get a fallback line so they never disappear from
 * the prompt silently when a new one ships.
 *
 * Lives next to the tool's `create*Tool` factory rather than in a central
 * table, so adding a tool means changing exactly one file.
 */
export interface TacoToolMetadata {
    /** One-paragraph prose (≤ 350 chars). Should explain *when* to use this
     *  tool vs. a sibling, not re-state the schema description verbatim. */
    readonly promptSummary?: string;
    /** Whether this tool mutates workspace state. Drives the
     *  `[read-only]` / `[mutates]` tag in the system prompt. Defaults to
     *  `true` when omitted — failure mode is conservative (model treats
     *  unknown tools as mutating). */
    readonly mutates?: boolean;
    /** Whether this tool is destructive / hard to reverse (e.g. overwrite,
     *  delete, raw shell). Shown as an additional `[destructive]` tag in the
     *  routing guide and may feed the permission layer. Defaults to false. */
    readonly destructive?: boolean;
}

declare module "@taco-ai/pi-harness" {
    // Augments `AgentTool` (an interface in pi-agent-core's barrel). Every
    // `AgentHarnessTool` extends `AgentTool` via `Omit<…, "execute"> & …`,
    // so the new field carries through to the `TacoTool` alias used by all
    // `create*Tool` factories without having to redefine the alias here.
    interface AgentTool<TParameters, TDetails> {
        readonly taco?: TacoToolMetadata;
    }
}

/**
 * Platform-independent base tools (no agent / tasks / plan). The memory
 * tool is always pushed — it reads `ctx.call` at execute time and throws
 * a clear error when the workspace has no self-RPC dispatcher, instead of
 * silently disappearing when a caller forgets to set `hasSelfRpc: true`.
 *
 * Callers that never wire `dispatchRpc` (e.g. the desktop's read-only admin
 * console) should filter the returned array themselves.
 */
export function defaultTools(opts?: {
    permissionBroker?: PermissionBroker;
    sessionId?: SessionId;
    disabledTools?: string[];
}): TacoTool[] {
    // pi-agent-core owns read/write/edit's schema and execute; we add the
    // prompt-routing metadata on top so the system-prompt builder has a
    // single source of truth for each tool (its factory, or this wrap site).
    // pi decodes non-images as text. Rewrite binary results so the model does not
    // treat mojibake as the file contents. Path resolution and image blocks stay in pi.
    // Typed against readBase, not TacoTool: that annotation widens params to unknown.
    const readBase = createReadTool();
    const readExecute: typeof readBase.execute = async (
        toolCallId,
        params,
        onUpdate,
        toolContext,
        invocation,
        context,
    ) => {
        // A PDF is parsed, not decoded: pi would hand back mojibake. Only a
        // file whose head is the PDF magic is read here. A mention of the
        // header that does not parse falls through, so the original text is
        // not replaced by the parser error.
        const bytes = await readPdfBytes(toolContext.env, params.path, context);
        if (bytes) {
            const pdf = await readPdf(bytes, params.path, params.offset, params.limit);
            if (!pdf.fallback) {
                const images = (pdf.images ?? []).map((page) => ({
                    type: "image" as const,
                    data: page.data,
                    mimeType: page.mimeType,
                }));
                return {
                    content: [{ type: "text", text: pdf.text }, ...images],
                    details: undefined,
                };
            }
        }
        const result = await readBase.execute(
            toolCallId,
            params,
            onUpdate,
            toolContext,
            invocation,
            context,
        );
        if (result.content.some((block) => block.type === "image")) return result;
        const text = result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
        const hint = binaryReadHint(text, params.path, () => commandOnPath("officecli"));
        if (!hint) return result;
        return { content: [{ type: "text", text: hint }], details: undefined };
    };
    const read: TacoTool = {
        ...readBase,
        description: `${readBase.description} PDF files are parsed: their text layer is returned, and a scanned document (no text layer) has its pages rendered as images. Other binary files (Office, archives, and files with NUL bytes) are not decoded as text, and the result names the format and what to use instead.`,
        taco: {
            promptSummary:
                "Read a file — prefer it over `shell cat` for truncation-aware output and image support. Text is truncated to ~30k tokens / 2000 lines; use `offset` and `limit` to page. Images (jpg/png/gif/webp) come back as attachments. A PDF returns its text; a scanned PDF returns page images. Other binary files are not decoded.",
            mutates: false,
        },
        execute: readExecute,
    };
    const write: TacoTool = {
        ...createWriteTool(),
        taco: {
            promptSummary:
                "Create or fully replace a file — use it only for brand-new files or wholesale rewrites. Prefer `edit` when only part of the file should change; `write` rewrites the whole file and is harder to review.",
            mutates: true,
            destructive: true,
        },
    };
    const edit: TacoTool = {
        ...createEditTool(),
        taco: {
            promptSummary:
                "Exact-string replacement — the tool for surgical changes to an existing file, where `write` would lose the parts you are not touching. Each `edits[].oldText` must match the file exactly and be unique in it (anchor with surrounding context if needed) — otherwise the call fails, so read the file first.",
            mutates: true,
        },
    };

    const tools: TacoTool[] = [
        read,
        write,
        edit,
        createGrepTool(),
        createGlobTool(),
        createAskUserTool(),
    ];
    const shell = createShellTool(opts);
    // annotate destructive on the shell tool so the routing guide carries the tag
    const annotatedShell: TacoTool = {
        ...shell,
        taco: { ...shell.taco, destructive: true },
    };
    tools.push(annotatedShell);
    tools.push(createMemoryTool());
    tools.push(...createPdfTools());
    const disabled = new Set(opts?.disabledTools ?? []);
    const filtered = disabled.size > 0 ? tools.filter((t) => !disabled.has(t.name)) : tools;
    return orderTools(filtered);
}

/**
 * Base tools + 5 task-management tools + 2 plan-mode tools + memory + jobs.
 * AttachedSession calls this on attach.
 *
 * Tool order is the system-prompt order — `orderTools` sorts by name so the
 * harness array and `TOOL_NAMES` stay aligned (plugins included).
 */
export function defaultToolsWithTasks(
    store: TaskStore,
    baseDir: string,
    planState: PlanModeState,
    projectDir: string,
    taskAdapter: TaskSnapshotPublisher,
    planPublisher: PlanSnapshotPublisher,
    sessionId: SessionId,
    permissionBroker?: PermissionBroker,
    disabledTools?: string[],
): TacoTool[] {
    const tools = defaultTools({ permissionBroker, sessionId, disabledTools });
    tools.push(createTodoWriteTool(store, baseDir, taskAdapter, sessionId));
    tools.push(createTaskCreateTool(store, baseDir, taskAdapter, sessionId));
    tools.push(createTaskUpdateTool(store, baseDir, taskAdapter, sessionId));
    tools.push(createTaskListTool(store));
    tools.push(createPlanEnterTool(planState, projectDir, planPublisher, sessionId));
    tools.push(createPlanExitTool(planState, projectDir, planPublisher, sessionId));
    tools.push(...createJobsTools());
    return orderTools(tools);
}
