import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { writeToClipboard } from "../../src/lib/clipboard";

/** Minimal DOM for the execCommand fallback — node:test has no document. */
function installFakeDocument(execCommand: (command: string) => boolean): {
    execCommand: string[];
} {
    const calls: string[] = [];
    const textarea = {
        value: "",
        style: {},
        setAttribute: () => {},
        select: () => {},
    };
    globalThis.document = {
        createElement: () => textarea,
        body: { appendChild: () => {}, removeChild: () => {} },
        execCommand: (command: string) => {
            calls.push(command);
            return execCommand(command);
        },
    } as unknown as Document;
    return { execCommand: calls };
}

afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(navigator, "clipboard");
});

describe("writeToClipboard", () => {
    it("falls back to execCommand when Clipboard API rejects", async () => {
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
                writeText: () => Promise.reject(new Error("denied")),
            },
        });
        const { execCommand } = installFakeDocument(() => true);

        assert.equal(await writeToClipboard("session-1"), true);
        assert.deepEqual(execCommand, ["copy"]);
    });
});
