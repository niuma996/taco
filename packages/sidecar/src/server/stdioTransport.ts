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
    }

    async send(frame: ServerFrame): Promise<void> {
        this.output.write(`${JSON.stringify(frame)}\n`);
    }

    onRequest(handler: (raw: string) => void): void {
        this.handler = handler;
    }

    async close(): Promise<void> {
        this.rl?.close();
    }
}
