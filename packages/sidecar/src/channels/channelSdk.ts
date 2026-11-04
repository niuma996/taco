import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { tacoHome } from "../config/tacoHome.ts";

const SDKS = {
    wechat: { name: "@wechatbot/wechatbot", version: "2.2.0" },
    wecom: { name: "@wecom/aibot-node-sdk", version: "1.0.7" },
} as const;

export type ChannelSdkName = keyof typeof SDKS;

export function channelSdkPrefix(): string {
    return join(tacoHome(), "vendor");
}

export function channelSdkInstallHint(name: ChannelSdkName): string {
    const sdk = SDKS[name];
    return (
        `${name} channel requires the ${sdk.name} optional dependency; install it with ` +
        `\`npm install --prefix "${channelSdkPrefix()}" ${sdk.name}@${sdk.version}\``
    );
}

/** Resolve the user install on each attempt; failed imports must not be cached. */
export async function loadChannelSdk(
    name: "wechat",
): Promise<typeof import("@wechatbot/wechatbot")>;
export async function loadChannelSdk(
    name: "wecom",
): Promise<typeof import("@wecom/aibot-node-sdk")>;
export async function loadChannelSdk(name: ChannelSdkName): Promise<unknown> {
    const specifier = SDKS[name].name;
    const require = createRequire(join(channelSdkPrefix(), "package.json"));
    let entry: string;
    try {
        if (!existsSync(join(channelSdkPrefix(), "node_modules", specifier, "package.json"))) {
            throw new Error("SDK not installed in the user prefix");
        }
        entry = require.resolve(specifier);
    } catch {
        // Workspace/npm consumers may already provide the optional dependency.
        return import(specifier);
    }
    return import(pathToFileURL(entry).href);
}

/** Only fixed channel SDKs can be installed; no shell or arbitrary package input. */
let installChain: Promise<void> = Promise.resolve();
const installing = new Map<string, Promise<void>>();

export function installChannelSdk(name: string): Promise<void> {
    const key = `${channelSdkPrefix()}:${name}`;
    const pending = installing.get(key);
    if (pending) return pending;
    const next = installChain.then(() => installSdk(name));
    installing.set(key, next);
    installChain = next.catch(() => undefined);
    void next.finally(() => installing.delete(key)).catch(() => undefined);
    return next;
}

async function installSdk(name: string): Promise<void> {
    if (name !== "wechat" && name !== "wecom") throw new Error(`unsupported channel SDK: ${name}`);
    const prefix = channelSdkPrefix();
    mkdirSync(prefix, { recursive: true });
    const paths = [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)];
    const candidates = paths.flatMap((path) => [
        join(path, "node_modules/npm/bin/npm-cli.js"),
        join(path, "../lib/node_modules/npm/bin/npm-cli.js"),
        join(path, "../node_modules/npm/bin/npm-cli.js"),
    ]);
    for (const path of paths) {
        const npm = join(path, "npm");
        if (existsSync(npm)) {
            const actual = realpathSync(npm);
            if (actual.endsWith("npm-cli.js")) candidates.push(actual);
        }
    }
    const npmCli = candidates.find(existsSync);
    // POSIX managers such as Volta/asdf may expose an executable shim rather
    // than npm-cli.js. Execute that shim directly; Windows uses the JS CLI.
    const npmShim =
        process.platform !== "win32"
            ? paths.map((path) => join(path, "npm")).find(existsSync)
            : undefined;
    if (!npmCli && !npmShim)
        throw new Error("npm is not available. Install Node.js with npm, then try again.");
    const sdk = SDKS[name];
    await new Promise<void>((resolve, reject) => {
        execFile(
            npmCli ? process.execPath : (npmShim as string),
            [
                ...(npmCli ? [npmCli] : []),
                "install",
                "--prefix",
                prefix,
                "--no-audit",
                "--no-fund",
                "--ignore-scripts",
                `${sdk.name}@${sdk.version}`,
            ],
            {
                windowsHide: true,
                timeout: 120_000,
                maxBuffer: 1024 * 1024,
            },
            (error, _stdout, stderr) => {
                if (error)
                    reject(
                        new Error(
                            `Channel dependency installation failed: ${stderr.trim() || error.message}`,
                        ),
                    );
                else resolve();
            },
        );
    });
    if (name === "wechat") await loadChannelSdk("wechat");
    else await loadChannelSdk("wecom");
}
