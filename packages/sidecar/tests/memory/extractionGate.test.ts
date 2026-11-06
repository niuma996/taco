import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryExtractorImpl } from "../../src/memory/local/extractor.ts";
import type { MemoryExtractionGateState } from "../../src/memory/types.ts";
import type { AgentMessage, Api, Model, Models } from "../../src/runtime/pi/types.ts";
import { extractionResponse } from "../_helpers/extractionResponse.ts";

const message = (id: string, text = "项目生产交付始终必须经过财务审批。".repeat(8)) =>
    ({ role: "user", content: text, memoryEntryId: id }) as unknown as AgentMessage;
function fixture() {
    let now = 1_000_000;
    let cursor: string | undefined;
    let gate: unknown;
    let calls = 0;
    let response = "[]";
    const store = {
        listTopics: () => [],
        appendEntry: async () => {},
        updateTopic: async () => {
            throw new Error("unused");
        },
    };
    const models = {
        completeSimple: async () => {
            calls++;
            return response === "[]"
                ? extractionResponse([])
                : { role: "assistant", content: [{ type: "text", text: response }] };
        },
    } as unknown as Models;
    const make = () =>
        new MemoryExtractorImpl(models, {} as Model<Api>, store, "session", () => undefined, {
            read: async () => cursor,
            write: async (id: string) => {
                cursor = id;
            },
            readGate: async () => gate as MemoryExtractionGateState | undefined,
            writeGate: async (value: unknown) => {
                gate = value;
            },
            now: () => now,
        });
    return {
        make,
        calls: () => calls,
        cursor: () => cursor,
        advance: (ms: number) => {
            now += ms;
        },
        response: (value: string) => {
            response = value;
        },
    };
}

describe("conservative automatic evaluation gate", () => {
    it("requires three distinct runs and 300 pending characters", async () => {
        const f = fixture();
        const extractor = f.make();
        const messages = [message("u1")];
        await extractor.onRunEnd(messages);
        assert.equal(f.calls(), 0);
        assert.equal(f.cursor(), undefined);
        await extractor.onRunEnd(messages);
        assert.equal(f.calls(), 0, "a repeated snapshot is not another user run");
        messages.push(message("u2"));
        await extractor.onRunEnd(messages);
        assert.equal(f.calls(), 0);
        messages.push(message("u3"));
        await extractor.onRunEnd(messages);
        assert.equal(f.calls(), 1);
        assert.equal(f.cursor(), "u3");
    });

    it("does not count a long single turn as three runs", async () => {
        const f = fixture();
        await f.make().onRunEnd([message("u1", "long ".repeat(1000))]);
        assert.equal(f.calls(), 0);
    });

    it("retains pending gate state across restart and honors the cooldown", async () => {
        const f = fixture();
        const messages = [message("u1")];
        await f.make().onRunEnd(messages);
        messages.push(message("u2"));
        await f.make().onRunEnd(messages);
        messages.push(message("u3"));
        await f.make().onRunEnd(messages);
        assert.equal(f.calls(), 1);
        for (let n = 4; n <= 6; n++) {
            messages.push(message(`u${n}`));
            await f.make().onRunEnd(messages);
        }
        assert.equal(f.calls(), 1);
        f.advance(5 * 60_000);
        await f.make().onRunEnd(messages);
        assert.equal(f.calls(), 2);
    });

    it("keeps failed input pending but avoids repeated provider calls during cooldown", async () => {
        const f = fixture();
        f.response("broken");
        const messages: AgentMessage[] = [];
        const extractor = f.make();
        for (let n = 1; n <= 3; n++) {
            messages.push(message(`u${n}`));
            await extractor.onRunEnd(messages);
        }
        assert.equal(f.calls(), 1);
        assert.equal(f.cursor(), undefined);
        await extractor.onRunEnd(messages);
        assert.equal(f.calls(), 1);
        f.advance(300_000);
        f.response("[]");
        await extractor.onRunEnd(messages);
        assert.equal(f.calls(), 1, "the first failure doubles the five-minute cooldown");
        f.advance(300_000);
        await extractor.onRunEnd(messages);
        assert.equal(f.calls(), 2);
        assert.equal(f.cursor(), "u3");
    });

    it("lets a successful tool write consume prior input without invoking extraction", async () => {
        const f = fixture();
        const extractor = f.make();
        const messages = [message("u1"), message("u2"), message("u3")];
        await extractor.onRunEnd(messages, { skipThroughEntryId: "u3" });
        assert.equal(f.calls(), 0);
        assert.equal(f.cursor(), "u3");
    });
});
