/**
 * TacoClient (Node) — spawns the sidecar child process and pipes stdio as NDJSON.
 *
 * Inherits dispatcher / buffer / typed RPC injection from TacoClientBase;
 * only the transport differs (`spawn` + readline on stdout).
 *
 * Node-only: `node:child_process` / `node:readline` / `node:crypto` / `node:events`.
 * Also exposes an EventEmitter-style API (on/emit) for debug-console tooling.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as readline from "node:readline";
import type {
    ClientCapabilities,
    InitializeResult,
    RpcRequest,
    ServerPush,
    SidecarHelloParams,
    WorkspaceId,
} from "@taco-ai/protocol";
import { isCompatibleSidecarProtocol, SIDECAR_PROTOCOL_VERSION } from "@taco-ai/protocol";
import { TacoClientBase } from "./tacoClientBase.js";

export interface TacoClientSpawnOptions {
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}

export interface TacoClientOptions {
    spawn: TacoClientSpawnOptions;
}

// The 20 typed methods are injected by `createTypedRpc` on the base class and merged via namesake interface (see TacoClientBase).
export interface TacoClient extends TacoClientBase {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: see interface comment above
export class TacoClient extends TacoClientBase {
    private proc?: ChildProcess;
    private readonly spawnOptions: TacoClientSpawnOptions;
    /** Node-only event bus for push / warn / stderr / exit — used by debug-console tooling. */
    private readonly nodeEvents = new EventEmitter();

    constructor(opts: TacoClientOptions) {
        super();
        this.spawnOptions = opts.spawn;
        // Forward dispatcher push / warn to nodeEvents so debug-console can subscribe via on().
        this.onPush((p) => this.nodeEvents.emit("push", p));
        this.onWarning((w) => this.nodeEvents.emit("warn", w));
    }

    /** Bad JSON line → emit("warn", { badFrame }). */
    protected override onBadLine(raw: string): void {
        this.nodeEvents.emit("warn", { badFrame: raw });
    }

    protected makeDispatch() {
        return {
            // Node's `call` takes (method, params). The child_process is process-global, so the workspace arg is ignored.
            call: <TParams, TResult>(
                method: string,
                _workspace: WorkspaceId,
                params: TParams,
            ): Promise<TResult> => this.call<TParams, TResult>(method, params),
            // No per-workspace routing concept; callProcess shares the path with call.
            callProcess: <TParams, TResult>(method: string, params: TParams): Promise<TResult> =>
                this.call<TParams, TResult>(method, params),
        };
    }

    /** EventEmitter-style subscription (push / warn / stderr / exit) — used by debug-console. */
    on(event: string, listener: (...args: unknown[]) => void): this {
        this.nodeEvents.on(event, listener);
        return this;
    }

    /** Emit an event (spawn internals emit "stderr" / "exit"). */
    emit(event: string, ...args: unknown[]): boolean {
        return this.nodeEvents.emit(event, ...args);
    }

    async start(): Promise<void> {
        if (this.proc) return;
        const p = spawn(this.spawnOptions.command, this.spawnOptions.args, {
            cwd: this.spawnOptions.cwd,
            env: { ...process.env, ...(this.spawnOptions.env ?? {}) },
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.proc = p;

        const stdout = p.stdout;
        if (!stdout) throw new Error("sidecar stdout unavailable");
        const rl = readline.createInterface({ input: stdout });
        rl.on("line", (line) => this.buffer.push(`${line}\n`));

        p.stderr?.on("data", (chunk) => {
            this.emit("stderr", String(chunk));
        });

        p.on("exit", (code, sig) => {
            this.rejectAllPending(
                new Error(`sidecar exited code=${code ?? "?"} sig=${sig ?? "?"}`),
            );
            this.emit("exit", { code, sig });
        });

        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    /**
     * Liveness + capability handshake for the hello-less protocol: send
     * `initialize` and validate the server's advertised protocol version.
     * This is the recommended entry point before any other RPC — the
     * server's `not_initialized` guard rejects everything else. Throws on
     * protocol mismatch so stale-sidecar failures surface up front instead
     * of on a specific RPC at runtime.
     */
    async handshake(clientCapabilities?: ClientCapabilities): Promise<InitializeResult> {
        const result = await this.initialize(
            { major: SIDECAR_PROTOCOL_VERSION.major, minor: SIDECAR_PROTOCOL_VERSION.minor },
            clientCapabilities,
        );
        const protocol = result.protocolVersion as { major?: unknown; minor?: unknown };
        if (
            typeof protocol?.major !== "number" ||
            typeof protocol?.minor !== "number" ||
            !isCompatibleSidecarProtocol({ major: protocol.major, minor: protocol.minor })
        ) {
            throw new Error(
                `sidecar protocol ${protocol?.major ?? "?"}.${protocol?.minor ?? "?"} is not supported; client is ${SIDECAR_PROTOCOL_VERSION.major}.${SIDECAR_PROTOCOL_VERSION.minor}`,
            );
        }
        return result;
    }

    /**
     * @deprecated The `sidecar.hello` push frame is being retired. Use the
     * `initialize` RPC exchange as the readiness signal instead. Kept for one
     * protocol transition period.
     *
     * Wait for the server's hello frame (used as a readiness signal).
     */
    async waitForHello(timeoutMs = 5_000): Promise<ServerPush> {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                unsub();
                reject(new Error("hello timeout"));
            }, timeoutMs);
            const unsub = this.onPush((p) => {
                if (p.method === "sidecar.hello") {
                    clearTimeout(t);
                    unsub();
                    resolve(p);
                }
            });
        });
    }

    /**
     * @deprecated Waiting on the hello frame is being retired; call
     * `initialize` directly — its response carries `protocolVersion` and now
     * also `instanceId`/`pid`. Kept for one protocol transition period.
     *
     * Liveness + capability handshake: wait for hello, then send `initialize` so
     * the server's `not_initialized` guard lets subsequent RPCs through. The
     * server's protocol version comes from the hello frame; we send the same
     * `SIDECAR_PROTOCOL_VERSION` the client was built with. Throws if either
     * step fails — the new server guard is a hard switch with no fallback.
     */
    async waitForReady(
        clientCapabilities?: ClientCapabilities,
        options: { helloTimeoutMs?: number } = {},
    ): Promise<ServerPush> {
        const hello = await this.waitForHello(options.helloTimeoutMs);
        // The desktop client gates on the hello protocol before initialize; do the
        // same here so debug tooling rejects a stale sidecar up front instead of
        // failing on a specific RPC at runtime. Validate the frame shape first so
        // a malformed hello is distinguishable from a version mismatch in logs.
        const params = hello.params as unknown;
        if (params === null || typeof params !== "object") {
            throw new Error("sidecar hello frame missing params object");
        }
        const protocol = (params as SidecarHelloParams).protocol;
        if (typeof protocol?.major !== "number" || typeof protocol?.minor !== "number") {
            throw new Error("sidecar hello frame missing protocol version");
        }
        if (!isCompatibleSidecarProtocol(protocol)) {
            throw new Error(
                `sidecar protocol ${protocol.major}.${protocol.minor} is not supported; client is ${SIDECAR_PROTOCOL_VERSION.major}.${SIDECAR_PROTOCOL_VERSION.minor}`,
            );
        }
        await this.initialize(
            { major: SIDECAR_PROTOCOL_VERSION.major, minor: SIDECAR_PROTOCOL_VERSION.minor },
            clientCapabilities,
        );
        return hello;
    }

    /** Pull — single request/response. */
    async call<TParams = unknown, TResult = unknown>(
        method: string,
        params?: TParams,
    ): Promise<TResult> {
        if (!this.proc?.stdin) throw new Error("client not started");
        const id = randomUUID();
        const req: RpcRequest<TParams> = { id, commandId: id, method, params: params as TParams };
        const paramsObject = params as unknown as { workspace?: unknown } | undefined;
        const workspace =
            params && typeof params === "object" && typeof paramsObject?.workspace === "string"
                ? paramsObject.workspace
                : "*";
        const promise = this.dispatcher.registerPending(id, workspace) as Promise<TResult>;
        this.proc.stdin.write(`${JSON.stringify(req)}\n`);
        return promise;
    }

    /** Active dispose. */
    async dispose(): Promise<void> {
        if (!this.proc) return;
        const proc = this.proc;
        this.proc = undefined;
        this.rejectAllPending(new Error("client disposed"));
        const exitPromise = new Promise<void>((r) => proc.once("exit", () => r()));
        proc.kill("SIGTERM");
        await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 1000))]);
        if (!proc.killed) proc.kill("SIGKILL");
        await exitPromise;
    }
}
