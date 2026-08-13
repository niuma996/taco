import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { wechatChannelManifest } from "../../src/channels/builtin/wechatManifest.ts";
import { BUILTIN_CHANNEL_MANIFESTS } from "../../src/channels/builtinManifests.ts";

describe("wechat manifest single source", () => {
    it("BUILTIN_CHANNEL_MANIFESTS advertises the same object the channel instance uses", () => {
        const advertised = BUILTIN_CHANNEL_MANIFESTS.find((m) => m.name === "wechat");
        assert.ok(advertised);
        assert.strictEqual(advertised, wechatChannelManifest);
    });
});
