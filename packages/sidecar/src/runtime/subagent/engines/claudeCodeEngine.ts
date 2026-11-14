import { stat } from "node:fs/promises";
import { asSessionId } from "@taco-ai/protocol";
import type { AgentDefinition } from "../../../agents/types.ts";
import { uuidv7 } from "../../pi/values.ts";
import type { ClaudeCodeCommunicationTools } from "../claudeCode/claudeCodeCommunication.ts";
import { runClaudeCodeSubagent } from "../claudeCode/claudeCodeRunner.ts";
import {
    type ClaudeAgentSdk,
    findClaudeExecutable,
    loadClaudeAgentSdk,
} from "../claudeCode/claudeCodeSdk.ts";
import { readClaudeCodeState, writeClaudeCodeState } from "../claudeCode/claudeCodeState.ts";
import type { AgentEngine, EngineRunRequest, NativeEngineDeps } from "./types.ts";

export interface ClaudeCodeEngineDeps extends NativeEngineDeps {
    readonly loadClaudeCodeSdk?: () => Promise<ClaudeAgentSdk>;
    readonly findClaudeCode?: () => string | undefined;
}

export function createClaudeCodeEngine(deps: ClaudeCodeEngineDeps): AgentEngine {
    return {
        runtime: "claude-code",
        capabilities: { forkContext: false, delivery: "nextTurn", workLane: false },
        async preflight(def: AgentDefinition): Promise<void> {
            if (def.cwd === undefined) return;
            const isDir = await stat(def.cwd)
                .then((entry) => entry.isDirectory())
                .catch(() => false);
            if (!isDir) {
                throw new Error(
                    `agent type "${def.agentType}" is set to run in ${def.cwd}, which is not an ` +
                        "existing directory. Ask the user to fix the subagent's directory in its settings.",
                );
            }
        },
        run: (args) => runClaudeCode(deps, args),
    };
}

async function runClaudeCode(deps: ClaudeCodeEngineDeps, args: EngineRunRequest) {
    const native = args.resume
        ? await deps.registry.withSession(args.childSessionId, readClaudeCodeState)
        : undefined;
    if (args.resume && !native) {
        return {
            subSessionId: args.childSessionId,
            isError: true,
            resultText:
                "This Claude Code session cannot be resumed: its native session mapping was not saved. Create a fresh agent explicitly.",
        };
    }

    const cwd = args.claudeCodeCwd ?? deps.executionCwd();
    if (
        native &&
        (native.cwd !== cwd ||
            native.configDir !== process.env.CLAUDE_CONFIG_DIR ||
            JSON.stringify(native.tools) !== JSON.stringify(args.claudeCodeTools) ||
            native.permissionMode !== args.permissionMode)
    ) {
        return {
            subSessionId: args.childSessionId,
            isError: true,
            resultText:
                "Claude Code continuation requires the original cwd, storage environment, tools and permission mode. The profile changed; create a new agent explicitly.",
        };
    }

    const communicationNames = (["chatToAgent", "listAgentSessions"] as const).filter(
        (name) =>
            args.claudeCodeTools === undefined ||
            args.claudeCodeTools.includes(name) ||
            args.claudeCodeTools.includes(`mcp__taco__${name}`),
    );
    const nativeTools = args.claudeCodeTools?.filter(
        (name) =>
            ![
                "chatToAgent",
                "listAgentSessions",
                "mcp__taco__chatToAgent",
                "mcp__taco__listAgentSessions",
            ].includes(name),
    );

    return runClaudeCodeSubagent({
        subSessionId: args.childSessionId,
        resumeSessionId: native?.nativeSessionId,
        onSessionId: (nativeSessionId) =>
            deps.registry.withSession(args.childSessionId, (session) =>
                writeClaudeCodeState(session, {
                    nativeSessionId,
                    cwd,
                    configDir: process.env.CLAUDE_CONFIG_DIR,
                    tools: args.claudeCodeTools,
                    permissionMode: args.permissionMode,
                }),
            ),
        onInputReady: (input) => deps.conversation.setInput(args.childSessionId, input),
        ...(communicationNames.length
            ? {
                  communicationTools: createClaudeCommunicationTools(
                      deps,
                      args,
                      communicationNames,
                  ),
              }
            : {}),
        agentType: args.agentType,
        prompt: args.prompt,
        rolePrompt: args.rolePrompt,
        maxTurns: args.maxTurns,
        tools: nativeTools,
        permissionMode: args.permissionMode,
        cwd,
        abortController: args.abortController,
        onUpdate: args.onUpdate,
        loadSdk: deps.loadClaudeCodeSdk ?? loadClaudeAgentSdk,
        findExecutable: deps.findClaudeCode ?? findClaudeExecutable,
        appendMessages: (messages) => deps.appendMessages(args.childSessionId, messages),
    });
}

function createClaudeCommunicationTools(
    deps: ClaudeCodeEngineDeps,
    args: EngineRunRequest,
    allowedNames: readonly ("chatToAgent" | "listAgentSessions")[],
): ClaudeCodeCommunicationTools {
    return {
        allowedNames,
        chat: (input) =>
            deps.conversation.chat(args.childSessionId, {
                ...input,
                subSessionId: asSessionId(input.subSessionId),
                parentToolCallId: `cc-message:${uuidv7()}`,
            }),
        list: () => deps.conversation.list(args.childSessionId),
    };
}
