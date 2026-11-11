import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import { KeyedQueue, SerialChain } from "../../src/store/serial.ts";

describe("SerialChain", () => {
    test("runs operations in submission order", async () => {
        const chain = new SerialChain();
        const order: string[] = [];
        await Promise.all([
            chain.run(async () => {
                await delay(10);
                order.push("first");
            }),
            chain.run(async () => {
                order.push("second");
            }),
        ]);
        deepStrictEqual(order, ["first", "second"]);
    });

    test("the chain survives a rejected operation", async () => {
        const chain = new SerialChain();
        await rejects(
            chain.run(async () => {
                throw new Error("boom");
            }),
            /boom/,
        );
        strictEqual(await chain.run(async () => "ok"), "ok");
    });
});

describe("KeyedQueue", () => {
    test("serializes operations that share a key", async () => {
        const queue = new KeyedQueue();
        const order: string[] = [];
        await Promise.all([
            queue.run("a", async () => {
                await delay(10);
                order.push("first");
            }),
            queue.run("a", async () => {
                order.push("second");
            }),
        ]);
        deepStrictEqual(order, ["first", "second"]);
    });

    test("different keys proceed concurrently", async () => {
        const queue = new KeyedQueue();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const blocked = queue.run("a", async () => {
            await gate;
            return "a";
        });
        // "b" must settle while "a" is still waiting on the gate.
        strictEqual(await queue.run("b", async () => "b"), "b");
        release();
        strictEqual(await blocked, "a");
    });

    test("a rejected operation releases its key", async () => {
        const queue = new KeyedQueue();
        await rejects(
            queue.run("a", async () => {
                throw new Error("boom");
            }),
            /boom/,
        );
        strictEqual(await queue.run("a", async () => "ok"), "ok");
    });
});

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
