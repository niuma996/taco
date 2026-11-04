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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
// Installing into the user prefix must recover in the same process, including
// a previous failed import; installing in the app directory is not required.
for (const [name, sdk, exports] of [
    ["wechat", "@wechatbot/wechatbot", "export class WeChatBot {}"],
    ["wecom", "@wecom/aibot-node-sdk", "export class WSClient {}"],
]) {
    const dir = join(process.env.TACO_HOME, "vendor", "node_modules", sdk);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: sdk, type: "module", exports: "./index.js" }));
    writeFileSync(join(dir, "index.js"), exports);
    const channel = await factory.create(name);
    assert.equal(channel.manifest.name, name);
}
`,
        );
        const child = spawnSync(process.execPath, [runner], {
            cwd: dir,
            encoding: "utf8",
            timeout: 10_000,
            env: { ...process.env, TACO_HOME: join(dir, "home") },
        });
        assert.equal(child.status, 0, child.stderr || child.stdout);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
