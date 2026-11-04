import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

test("bundled channel factory loads without optional SDKs and reports missing SDKs on create", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taco-optional-channel-sdks-"));
    try {
        await build({
            entryPoints: [
                fileURLToPath(new URL("../../src/channels/channelFactory.ts", import.meta.url)),
            ],
            outfile: join(dir, "factory.mjs"),
            bundle: true,
            format: "esm",
            platform: "node",
            target: "node22",
            minify: true,
            external: ["@wechatbot/wechatbot", "@wecom/aibot-node-sdk"],
            logLevel: "silent",
        });
        const runner = join(dir, "smoke.mjs");
        writeFileSync(
            runner,
            `import { strict as assert } from "node:assert";
import { ChannelFactory, WechatSdkMissingError, WecomSdkMissingError } from "./factory.mjs";
const factory = new ChannelFactory({ broker: {}, resolveRoute: () => undefined });
assert.ok(await factory.create("mock"));
for (const [name, ErrorType, sdk] of [
    ["wechat", WechatSdkMissingError, "@wechatbot/wechatbot"],
    ["wecom", WecomSdkMissingError, "@wecom/aibot-node-sdk"],
]) {
    await assert.rejects(factory.create(name), (error) => {
        assert.ok(error instanceof ErrorType);
        assert.equal(error.cause.code, "ERR_MODULE_NOT_FOUND");
        assert.ok(error.cause.message.includes(sdk));
        return true;
    });
}
`,
        );
        const child = spawnSync(process.execPath, [runner], {
            cwd: dir,
            encoding: "utf8",
            timeout: 10_000,
        });
        assert.equal(child.status, 0, child.stderr || child.stdout);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
