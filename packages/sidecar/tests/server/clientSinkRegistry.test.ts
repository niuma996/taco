import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientSinkRegistry } from "../../src/server/clientSinkRegistry.ts";
import { NullTransport } from "../../src/server/nullTransport.ts";
import type { Transport } from "../../src/server/transport.ts";

describe("ClientSinkRegistry.hasClient", () => {
    it("ignores non-interactive sinks such as the resident host's NullTransport", () => {
        const registry = new ClientSinkRegistry();
        registry.add(new NullTransport());
        assert.equal(registry.hasClient(), false);
        const desktop: Transport = {
            open: async () => {},
            close: async () => {},
            send: async () => {},
            onRequest: () => {},
        };
        registry.add(desktop);
        assert.equal(registry.hasClient(), true);
        registry.remove(desktop);
        assert.equal(registry.hasClient(), false);
    });
});
