import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateChannelConfigValues } from "../../src/channels/configValidator.ts";
import type { ChannelManifest } from "../../src/channels/types.ts";

const manifest: ChannelManifest = {
    name: "mock",
    version: "0.1.0",
    capabilities: { maxMessageLength: 4096 },
    configSchema: [
        { key: "appId", type: "string", required: true },
        { key: "appSecret", type: "secret", required: true },
        { key: "enabled", type: "boolean" },
        { key: "retries", type: "number" },
    ],
};

describe("validateChannelConfigValues", () => {
    it("accepts a fully valid config", () => {
        const res = validateChannelConfigValues(manifest, {
            appId: "cli_1",
            appSecret: "s",
            enabled: true,
            retries: 3,
        });
        assert.equal(res.ok, true);
    });

    it("rejects when a required field is missing", () => {
        const res = validateChannelConfigValues(manifest, { appId: "cli_1" });
        assert.equal(res.ok, false);
    });

    it("passes through scalar values including secrets as strings", () => {
        const res = validateChannelConfigValues(manifest, { appId: "cli_1", appSecret: "plain" });
        assert.equal(res.ok, true);
        if (res.ok) assert.equal(res.validated.appSecret, "plain");
    });
});
