import * as readline from "node:readline";
import type { ServerFrame, Transport } from "./transport.ts";

export class StdioTransport implements Transport {
    private rl?: readline.Interface;
    private handler?: (raw: string) => void;

    constructor(
        private readonly input: NodeJS.ReadableStream = process.stdin,
        private readonly output: NodeJS.WritableStream = process.stdout,
    ) {}

    async open(): Promise<void> {
        this.rl = readline.createInterface({
            input: this.input,
            terminal: false,
            crlfDelay: Number.POSITIVE_INFINITY,
        });
        this.rl.on("line", (line) => this.handler?.(line));
        // Guard against peer-closed sockets. When the desktop races 5
        // workspaces in parallel and some abort mid-handshake, the socket
        // errors with EPIPE. The error propagates to BOTH the raw socket and
        // the readline interface built on top — without an `error` listener
        // on either, Node treats it as an uncaught exception and the whole
        // daemon exits. Connection-level `socket.on("error", …)` covers the
        // socket itself but not the readline wrapper, so we attach it here.
        this.rl.on("error", () => {
            /* peer closed — daemon keeps running for everyone else */
        });
        if (typeof this.input.on === "function") {
            this.input.on("error", () => {
                /* swallow — same race as above */
            });
        }
    }

    async send(frame: ServerFrame): Promise<void> {
        const w = this.output as NodeJS.WritableStream & {
            write: (chunk: string) => boolean;
        };
        try {
            w.write(`${JSON.stringify(frame)}\n`);
        } catch {
            /* synchronous EPIPE on a closed stream — non-fatal */
        }
    }

    onRequest(handler: (raw: string) => void): void {
        this.handler = handler;
    }

    async close(): Promise<void> {
        this.rl?.close();
    }
}
