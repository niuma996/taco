import assert from "node:assert/strict";
import { it } from "node:test";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import {
    type CodexRuntimeInstallDeps,
    codexLoginCommand,
    codexManualInstallCommand,
    codexNpmInstallArgs,
    codexRuntimeUnavailableMessage,
    getCodexRuntimeStatus,
    installCodexRuntime,
    parseCodexLoginStatus,
    quoteCommandToken,
    windowsNpmFallback,
} from "../../src/runtime/subagent/codex/codexRuntimeInstall.ts";
import {
    CodexSdkBinaryMissingError,
    type CodexSdkModule,
    type LoadedCodexSdk,
} from "../../src/runtime/subagent/codex/codexSdk.ts";

/** A user configuration with no Codex home — nothing to authenticate with. */
function noUserConfig() {
    return {
        home: "/nonexistent",
        provider: "openai",
        requiresOpenAiAuth: true,
        hasOpenAiCredentials: false,
        readable: false,
    };
}

/** A custom provider that brings its own credentials, like a third-party setup. */
function customProviderConfig() {
    return {
        home: "/nonexistent",
        model: "some-model",
        provider: "custom",
        requiresOpenAiAuth: false,
        hasOpenAiCredentials: false,
        readable: true,
    };
}

function loaded(): LoadedCodexSdk {
    return {
        module: {} as CodexSdkModule,
        version: "0.167.2",
        packageRoot: "/vendor/node_modules/@openai/codex-sdk",
        entryPath: "/vendor/node_modules/@openai/codex-sdk/dist/index.js",
    };
}

it("parses only explicit Codex login output", () => {
    assert.equal(parseCodexLoginStatus("Logged in using ChatGPT"), "signed-in");
    assert.equal(parseCodexLoginStatus("Not logged in"), "signed-out");
    assert.equal(parseCodexLoginStatus("Not signed in"), "signed-out");
    assert.equal(parseCodexLoginStatus("who knows"), "unknown");
});

it("reports an uninstalled runtime when the SDK cannot be loaded", async () => {
    const status = await getCodexRuntimeStatus({
        loadSdk: async () => {
            throw new Error("missing");
        },
        readUserConfig: noUserConfig,
    });
    assert.equal(status.runtime, "codex");
    assert.equal(status.installed, false);
    assert.equal(status.auth, "unknown");
    assert.equal(status.installCommand, codexManualInstallCommand());
    assert.ok(status.installer === "available" || status.installer === "missing");
});

it("reports the resolved version and best-effort auth from the managed CLI", async () => {
    const status = await getCodexRuntimeStatus({
        loadSdk: async () => loaded(),
        createClient: () => ({
            startThread: () => assert.fail(),
            resumeThread: () => assert.fail(),
        }),
        resolveCliEntry: () => "/vendor/node_modules/@openai/codex/bin/codex.js",
        readAuth: async (entry) => {
            assert.equal(entry, "/vendor/node_modules/@openai/codex/bin/codex.js");
            return "signed-in";
        },
        readUserConfig: noUserConfig,
    });
    assert.equal(status.installed, true);
    assert.equal(status.version, "0.167.2");
    assert.equal(status.auth, "signed-in");
    assert.equal(status.installCommand, codexManualInstallCommand());
    assert.ok(status.installer === "available" || status.installer === "missing");
});

it("keeps the runtime installed when auth probing fails", async () => {
    const status = await getCodexRuntimeStatus({
        loadSdk: async () => loaded(),
        createClient: () => ({
            startThread: () => assert.fail(),
            resumeThread: () => assert.fail(),
        }),
        resolveCliEntry: () => "/codex.js",
        readAuth: async () => {
            throw new Error("probe failed");
        },
        readUserConfig: noUserConfig,
    });
    assert.equal(status.installed, true);
    assert.equal(status.auth, "unknown");
});

it("treats a missing platform binary as not installed", async () => {
    const status = await getCodexRuntimeStatus({
        loadSdk: async () => loaded(),
        createClient: () => {
            throw new CodexSdkBinaryMissingError(new Error("missing optional dependency"));
        },
        readUserConfig: noUserConfig,
    });
    assert.equal(status.installed, false);
    assert.equal(status.auth, "unknown");
});

it("treats a custom provider as usable without an OpenAI login", async () => {
    const status = await getCodexRuntimeStatus({
        loadSdk: async () => loaded(),
        createClient: () => ({
            startThread: () => assert.fail(),
            resumeThread: () => assert.fail(),
        }),
        resolveCliEntry: () => "/vendor/node_modules/@openai/codex/bin/codex.js",
        readUserConfig: customProviderConfig,
    });
    assert.equal(status.auth, "signed-in");
    assert.equal(status.model, "some-model");
    assert.equal(status.provider, "custom");
    assert.equal(
        status.loginCommand,
        undefined,
        "a provider with its own credentials needs no login command",
    );
});

it("offers the login command only when OpenAI auth is the missing piece", async () => {
    const status = await getCodexRuntimeStatus({
        loadSdk: async () => loaded(),
        createClient: () => ({
            startThread: () => assert.fail(),
            resumeThread: () => assert.fail(),
        }),
        resolveCliEntry: () => "/vendor/node_modules/@openai/codex/bin/codex.js",
        readUserConfig: () => ({
            home: "/nonexistent",
            provider: "openai",
            requiresOpenAiAuth: true,
            hasOpenAiCredentials: false,
            readable: true,
        }),
    });
    assert.equal(status.auth, "signed-out");
    assert.equal(
        status.loginCommand,
        codexLoginCommand("/vendor/node_modules/@openai/codex/bin/codex.js"),
    );
});

it("does not probe OpenAI login for a readable but unknown provider", async () => {
    let probes = 0;
    const status = await getCodexRuntimeStatus({
        loadSdk: async () => loaded(),
        createClient: () => ({
            startThread: () => assert.fail(),
            resumeThread: () => assert.fail(),
        }),
        resolveCliEntry: () => "/vendor/node_modules/@openai/codex/bin/codex.js",
        readAuth: async () => {
            probes++;
            return "signed-out";
        },
        readUserConfig: () => ({
            home: "/nonexistent",
            provider: "missing-provider",
            requiresOpenAiAuth: undefined,
            hasOpenAiCredentials: false,
            readable: true,
        }),
    });
    assert.equal(status.auth, "unknown");
    assert.equal(status.loginCommand, undefined);
    assert.equal(probes, 0);
});

it("installs exactly the pinned SDK and verifies the result", async () => {
    const calls: Array<{
        command: string;
        args: string[];
        env: Record<string, string>;
        cwd: string;
    }> = [];
    const deps: CodexRuntimeInstallDeps = {
        runNpm: async (command, args, options) => {
            calls.push({ command, args, ...options });
        },
        probe: async () => ({
            runtime: "codex",
            installed: true,
            version: "0.167.2",
            auth: "signed-out",
        }),
    };
    const result = await installCodexRuntime(deps);
    assert.deepEqual(result, { runtime: "codex", ok: true, version: "0.167.2" });
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.args.includes("@openai/codex-sdk@0.167.2"));
    assert.ok(calls[0]?.args.includes("--include=optional"));
    assert.ok(calls[0]?.args.includes("--ignore-scripts"));
    assert.ok(calls[0]?.args.includes("--no-audit"));
    assert.ok(calls[0]?.args.includes("--no-fund"));
    assert.equal(typeof calls[0]?.env, "object");
    assert.equal(calls[0]?.cwd, calls[0]?.args[calls[0].args.indexOf("--prefix") + 1]);
});

it("builds the complete pinned npm argument vector", () => {
    assert.deepEqual(codexNpmInstallArgs("/managed"), [
        "install",
        "--prefix",
        "/managed",
        "--include=optional",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "@openai/codex-sdk@0.167.2",
    ]);
});

it("routes Windows npm shims through ComSpec", () => {
    assert.deepEqual(
        windowsNpmFallback("C:\\Windows\\System32\\cmd.exe", "C:\\Program Files\\nodejs\\npm.cmd"),
        {
            command: "C:\\Windows\\System32\\cmd.exe",
            argsPrefix: ["/d", "/s", "/c", "C:\\Program Files\\nodejs\\npm.cmd"],
        },
    );
});

it("scrubs provider keys from the installer environment", async () => {
    const original = process.env.OPENAI_API_KEY;
    const store = new ProviderKeyStore({ openai: "sk-must-not-leak" });
    let env: Record<string, string> | undefined;
    try {
        await installCodexRuntime({
            runNpm: async (_command, _args, options) => {
                env = options.env;
            },
            probe: async () => ({
                runtime: "codex",
                installed: true,
                version: "0.167.2",
                auth: "unknown",
            }),
        });
    } finally {
        store.update({ openai: "" });
        if (original === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = original;
    }
    assert.equal(env?.OPENAI_API_KEY, undefined);
});

it("deduplicates concurrent installation requests", async () => {
    let installs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const deps: CodexRuntimeInstallDeps = {
        runNpm: async () => {
            installs++;
            await gate;
        },
        probe: async () => ({
            runtime: "codex",
            installed: true,
            version: "0.167.2",
            auth: "unknown",
        }),
    };
    const first = installCodexRuntime(deps);
    const second = installCodexRuntime(deps);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(installs, 1);
    assert.deepEqual(a, b);
});

it("keeps a missing runtime actionable", () => {
    const missing = codexRuntimeUnavailableMessage(new Error("missing"));
    assert.match(missing, /not installed/);
    assert.match(missing, /@openai\/codex-sdk@0\.167\.2/);
});

it("renders shell-ready commands that only quote what needs quoting", () => {
    const command = codexManualInstallCommand();
    assert.ok(command.startsWith("npm install --prefix "), command);
    assert.ok(command.includes("@openai/codex-sdk@0.167.2"), command);
    assert.ok(!command.includes('"npm"'), command);
    assert.ok(!command.includes('"--prefix"'), command);
    assert.equal(quoteCommandToken("/tmp/plain path"), '"/tmp/plain path"');
    assert.equal(quoteCommandToken("/tmp/plain"), "/tmp/plain");
});
