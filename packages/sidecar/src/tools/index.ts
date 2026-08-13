/**
 * Register TACO's built-in tools.
 *
 *  - read / write / edit   — pi builtins
 *  - grep / glob           — context-aware search
 *  - shell                 — context-aware shell (platform-conditional)
 *  - agent / Skill         — per-session; main-session only
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import {
    createEditTool,
    createReadTool,
    createWriteTool,
    type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import type { SessionId } from "@taco-ai/protocol";
import type { PlanSnapshotPublisher } from "../plan/planPushAdapter.ts";
import type { TaskSnapshotPublisher } from "../tasks/taskPushAdapter.ts";
import type { TaskStore } from "../tasks/taskTypes.ts";
import { createAskUserTool } from "./askUser.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createMemoryTool, type MemoryToolDeps } from "./memory.ts";

export type { MemoryToolDeps };

import type { PermissionBroker } from "../permissions/permissionBroker.ts";
import { createPlanEnterTool } from "./planEnter.ts";
import { createPlanExitTool } from "./planExit.ts";
import type { PlanModeState } from "./planModeState.ts";
import { createShellTool } from "./shellTool.ts";
import { createTaskCreateTool } from "./taskCreate.ts";
import { createTaskListTool } from "./taskList.ts";
import { createTaskUpdateTool } from "./taskUpdate.ts";
import { createTodoWriteTool } from "./todoWrite.ts";

export type TacoTool = AgentHarnessTool<ExecutionToolContext>;

/**
 * Metadata the system-prompt builder reads off each tool. Optional — tools
 * that omit `promptSummary` get a fallback line so they never disappear from
 * the prompt silently when a new one ships.
 *
 * Lives next to the tool's `create*Tool` factory rather than in a central
 * table, so adding a tool means changing exactly one file.
 */
export interface TacoToolMetadata {
    /** One-paragraph prose (≤ 280 chars). Should explain *when* to use this
     *  tool vs. a sibling, not re-state the schema description verbatim. */
    readonly promptSummary?: string;
    /** Whether this tool mutates workspace state. Drives the
     *  `[read-only]` / `[mutates]` tag in the system prompt and the
     *  parallel-vs-sequential guidance. Defaults to `true` when omitted —
     *  failure mode is conservative (model treats unknown tools as mutating
     *  and serialises them). */
    readonly mutates?: boolean;
}

declare module "@earendil-works/pi-agent-core" {
    // Augments `AgentTool` (an interface in pi-agent-core's barrel). Every
    // `AgentHarnessTool` extends `AgentTool` via `Omit<…, "execute"> & …`,
    // so the new field carries through to the `TacoTool` alias used by all
    // `create*Tool` factories without having to redefine the alias here.
    interface AgentTool<TParameters, TDetails> {
        readonly taco?: TacoToolMetadata;
    }
}

/** Platform-independent base tools (no agent / memory / tasks / plan). */
export function defaultTools(opts?: {
    memoryDeps?: MemoryToolDeps;
    permissionBroker?: PermissionBroker;
    sessionId?: SessionId;
    disabledTools?: string[];
}): TacoTool[] {
    // pi-agent-core owns read/write/edit's schema and execute; we add the
    // prompt-routing metadata on top so the system-prompt builder has a
    // single source of truth for each tool (its factory, or this wrap site).
    const read: TacoTool = {
        ...createReadTool(),
        taco: {
            promptSummary:
                "Read a file — prefer it over `shell cat` for truncation-aware output and image support. Text is truncated to ~30k tokens / 2000 lines (whichever hits first); use `offset` and `limit` to page through. Supports images (jpg/png/gif/webp) as attachments.",
            mutates: false,
        },
    };
    const write: TacoTool = {
        ...createWriteTool(),
        taco: {
            promptSummary:
                "Create or fully replace a file — use it only for brand-new files or wholesale rewrites. Prefer `edit` when only part of the file should change; `write` rewrites the whole file and is harder to review.",
            mutates: true,
        },
    };
    const edit: TacoTool = {
        ...createEditTool(),
        taco: {
            promptSummary:
                "Exact-string replacement — the tool for surgical changes to an existing file, where `write` would lose the parts you are not touching. The `old_string` must be unique in the file (anchor with surrounding context if needed) and you must have read the file in this session — otherwise the call fails.",
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
    tools.push(createShellTool(opts));
    if (opts?.memoryDeps) {
        tools.push(createMemoryTool(opts.memoryDeps));
    }
    const disabled = new Set(opts?.disabledTools ?? []);
    return disabled.size > 0 ? tools.filter((t) => !disabled.has(t.name)) : tools;
}

/**
 * Base tools + 5 task-management tools + 2 plan-mode tools + memory tool.
 * AttachedSession calls this on attach.
 *
 * Tool order is the system-prompt order — `toolSummaryForPrompt` reads the
 * returned array as-is and renders one line per tool in that sequence. If
 * you reorder the `push` calls below, update the prompt-tested order in
 * `tests/prompts/prompts.test.ts` and re-read each tool's `promptSummary`
 * to make sure the rendered sequence still makes sense to a model.
 */
export function defaultToolsWithTasks(
    store: TaskStore,
    baseDir: string,
    planState: PlanModeState,
    projectDir: string,
    taskAdapter: TaskSnapshotPublisher,
    planPublisher: PlanSnapshotPublisher,
    sessionId: SessionId,
    memoryDeps?: MemoryToolDeps,
    permissionBroker?: PermissionBroker,
    disabledTools?: string[],
): TacoTool[] {
    const tools = defaultTools({ memoryDeps, permissionBroker, sessionId, disabledTools });
    tools.push(createTodoWriteTool(store, baseDir, taskAdapter, sessionId));
    tools.push(createTaskCreateTool(store, baseDir, taskAdapter, sessionId));
    tools.push(createTaskUpdateTool(store, baseDir, taskAdapter, sessionId));
    tools.push(createTaskListTool(store));
    tools.push(createPlanEnterTool(planState, projectDir, planPublisher, sessionId));
    tools.push(createPlanExitTool(planState, projectDir, planPublisher, sessionId));
    return tools;
}
