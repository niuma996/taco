import { realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asSessionId } from "@taco-ai/protocol";
import type { AgentDefinition } from "../../../agents/types.ts";
import { createLogger } from "../../../lib/logger.ts";
import { scrubbedProcessEnv } from "../../models/providerKeyStore.ts";
import { uuidv7 } from "../../pi/values.ts";
import {
    type CodexCommunicationBridge,
    createCodexCommunicationBridge,
} from "../codex/codexCommunication.ts";
import { runCodexSubagent } from "../codex/codexRunner.ts";
import { codexRuntimeUnavailableMessage } from "../codex/codexRuntimeInstall.ts";
import {
    CODEX_SDK_VERSION,
    createCodexClient,
    type LoadedCodexSdk,
    loadCodexSdk,
} from "../codex/codexSdk.ts";
import {
    type CodexState,
    codexProfileIdentity,
    readCodexState,
    writeCodexState,
} from "../codex/codexState.ts";
import type { AgentEngine, EngineRunRequest, NativeEngineDeps } from "./types.ts";

const log = createLogger("sidecar.codexEngine");

export interface CodexEngineDeps extends NativeEngineDeps {
    readonly getAllowedCwds: () => readonly string[];
    readonly loadCodexSdkForRun?: () => Promise<LoadedCodexSdk>;
}

export function createCodexEngine(deps: CodexEngineDeps): AgentEngine {
    return {
        runtime: "codex",
        capabilities: { forkContext: false, delivery: "afterRun", workLane: true },
        async preflight(def: AgentDefinition): Promise<void> {
            await resolveCodexCwd(deps, def.codex?.cwd);
            try {
                const loaded = await (deps.loadCodexSdkForRun ?? loadCodexSdk)();
                createCodexClient(loaded.module, { env: scrubbedProcessEnv() });
            } catch (error) {
                throw new Error(codexRuntimeUnavailableMessage(error));
            }
        },
        run: (args) => runCodex(deps, args),
    };
}

async function runCodex(deps: CodexEngineDeps, args: EngineRunRequest) {
    let cwd: string;
    try {
        cwd = await resolveCodexCwd(deps, args.codexConfig?.cwd);
    } catch (error) {
        return {
            subSessionId: args.childSessionId,
            isError: true,
            resultText: error instanceof Error ? error.message : String(error),
        };
    }
    const model = args.codexConfig?.model?.trim();
    const configWithoutModel = { ...(args.codexConfig ?? {}) };
    delete configWithoutModel.model;
    const effectiveConfig = {
        ...configWithoutModel,
        ...(model !== undefined && model !== "" ? { model } : {}),
        sandbox: args.codexConfig?.sandbox ?? ("read-only" as const),
        approvalPolicy: args.codexConfig?.approvalPolicy ?? ("never" as const),
    };
    const skipGitRepoCheck = !(await isInsideGitWorktree(cwd));
    const communicationNames = (["chatToAgent", "listAgentSessions"] as const).filter(
        (name) =>
            args.codexTools === undefined ||
            args.codexTools.includes(name) ||
            args.codexTools.includes(`mcp__taco__${name}`),
    );
    const profileIdentity = codexProfileIdentity(
        args.agentType,
        effectiveConfig,
        communicationNames,
        args.rolePrompt,
    );
    const native = args.resume
        ? await deps.registry.withSession(args.childSessionId, readCodexState)
        : undefined;
    if (args.resume && !native) {
        return {
            subSessionId: args.childSessionId,
            isError: true,
            resultText:
                "This Codex session cannot be resumed because its native thread mapping was not saved. Create a fresh agent explicitly.",
        };
    }
    if (
        native &&
        (native.cwd !== cwd ||
            native.profileIdentity !== profileIdentity ||
            native.sdkVersion !== CODEX_SDK_VERSION ||
            native.threadOptions.skipGitRepoCheck !== skipGitRepoCheck)
    ) {
        return {
            subSessionId: args.childSessionId,
            isError: true,
            resultText:
                "Codex continuation requires the original cwd, SDK version, and profile options. The profile changed; create a new agent explicitly.",
        };
    }
    const state: CodexState = native ?? {
        nativeThreadId: "",
        cwd,
        profileIdentity,
        sdkVersion: CODEX_SDK_VERSION,
        threadOptions: {
            ...(effectiveConfig.model !== undefined ? { model: effectiveConfig.model } : {}),
            sandbox: effectiveConfig.sandbox,
            approvalPolicy: effectiveConfig.approvalPolicy,
            skipGitRepoCheck,
            ...(communicationNames.length > 0 ? { communicationTools: communicationNames } : {}),
        },
    };

    let communicationBridge: CodexCommunicationBridge | undefined;
    try {
        if (communicationNames.length > 0) {
            communicationBridge = await createCodexCommunicationBridge({
                allowedNames: communicationNames,
                chat: (input) =>
                    deps.conversation.chat(args.childSessionId, {
                        ...input,
                        subSessionId: asSessionId(input.subSessionId),
                        parentToolCallId: `codex-message:${uuidv7()}`,
                    }),
                list: () => deps.conversation.list(args.childSessionId),
            });
        }
        deps.conversation.markRunning(args.childSessionId, args.executionId);
        return await runCodexSubagent({
            subSessionId: args.childSessionId,
            agentType: args.agentType,
            prompt: args.prompt,
            ...(native ? { resumeThreadId: native.nativeThreadId } : {}),
            ...(native
                ? {}
                : {
                      onThreadId: async (nativeThreadId: string) =>
                          deps.registry.withSession(args.childSessionId, (session) =>
                              writeCodexState(session, { ...state, nativeThreadId }),
                          ),
                  }),
            rolePrompt: args.rolePrompt,
            config: effectiveConfig,
            ...(communicationBridge ? { mcpServers: { taco: communicationBridge.mcpServer } } : {}),
            cwd,
            skipGitRepoCheck,
            abortController: args.abortController,
            onUpdate: args.onUpdate,
            loadSdk: async () => (await (deps.loadCodexSdkForRun ?? loadCodexSdk)()).module,
            appendMessages: (messages) => deps.appendMessages(args.childSessionId, messages),
        });
    } finally {
        try {
            await communicationBridge?.close();
        } catch (error) {
            log.warn("Codex communication bridge cleanup failed", {
                subSessionId: args.childSessionId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

async function resolveCodexCwd(deps: CodexEngineDeps, requested?: string): Promise<string> {
    const fallback = deps.executionCwd();
    const candidate = await realpath(requested ?? fallback).catch(() => undefined);
    if (!candidate)
        throw new Error(`Codex cwd is not an existing directory: ${requested ?? fallback}`);
    const isDir = await stat(candidate)
        .then((entry) => entry.isDirectory())
        .catch(() => false);
    if (!isDir) throw new Error(`Codex cwd is not an existing directory: ${candidate}`);
    const allowed = await Promise.all(
        deps.getAllowedCwds().map((root) => realpath(root).catch(() => undefined)),
    );
    if (!allowed.includes(candidate)) {
        throw new Error(
            `Codex cwd must be the workspace directory or one of its associated directories: ${candidate}`,
        );
    }
    return candidate;
}

async function isInsideGitWorktree(cwd: string): Promise<boolean> {
    let current = cwd;
    while (true) {
        const found = await stat(join(current, ".git"))
            .then(() => true)
            .catch(() => false);
        if (found) return true;
        const parent = dirname(current);
        if (parent === current) return false;
        current = parent;
    }
}
