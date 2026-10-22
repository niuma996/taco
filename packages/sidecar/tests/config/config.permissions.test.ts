// Config validation tests: command permissions (validators + disk edits) and mcpServers.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    saveGlobalConfig,
    validateCommandPermissions,
    validateMcpServers,
} from "../../src/config/config.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

describe("validateCommandPermissions", () => {
    it("returns the default ask config for nullish input", () => {
        assert.deepEqual(validateCommandPermissions(undefined, "t"), {
            mode: "ask",
            allow: [],
            deny: [],
        });
        assert.deepEqual(validateCommandPermissions(null, "t"), {
            mode: "ask",
            allow: [],
            deny: [],
        });
    });

    it("rejects non-object input", () => {
        assert.throws(() => validateCommandPermissions("ask", "t"), /expected object/);
    });

    it("normalizes unknown mode to ask", () => {
        const v = validateCommandPermissions({ mode: "bypass", rules: [] }, "t");
        assert.equal(v.mode, "ask");
    });

    it("accepts string patterns directly", () => {
        const v = validateCommandPermissions(
            { mode: "ask", rules: ["mmx *", "pnpm test", "git *"] },
            "t",
        );
        assert.deepEqual(v.allow, ["mmx *", "pnpm test", "git *"]);
    });

    it("trims and deduplicates string rules", () => {
        const v = validateCommandPermissions(
            { mode: "ask", rules: ["  pnpm test  ", "pnpm test"] },
            "t",
        );
        assert.deepEqual(v.allow, ["pnpm test"]);
    });

    // Every legacy shape below lands on the same `rules[i] must be a string
    // pattern` throw — they are one branch, kept as a table because they are
    // the four ways a user could still have the pre-migration shape on disk.
    it("rejects legacy { kind, command } rules in every shape", () => {
        const legacyShapes: unknown[] = [
            // The original exact-match form.
            { mode: "ask", rules: [{ kind: "exact", command: "pnpm test" }] },
            // The original prefix-match form.
            { mode: "auto", rules: [{ kind: "prefix", command: "mmx " }] },
            // First legacy entry wins in a list that interleaves legacy and
            // string rules — the loop must not skip past it to validate the rest.
            {
                mode: "auto",
                rules: [
                    { kind: "exact", command: "ls" },
                    "ls",
                    { kind: "prefix", command: "git " },
                    "git *",
                ],
            },
            // A legacy rule whose base is a shell wrapper must not slip through
            // as a string pattern.
            {
                mode: "auto",
                rules: [{ kind: "exact", command: "bash -c 'rm -rf /'" }],
            },
        ];

        for (const value of legacyShapes) {
            assert.throws(
                () => validateCommandPermissions(value, "t"),
                /legacy { kind, command } shape is no longer supported/,
            );
        }
    });

    it("skips empty or whitespace-only string entries", () => {
        const v = validateCommandPermissions(
            {
                mode: "ask",
                rules: ["", "   ", "bash -c 'echo hi'"],
            },
            "t",
        );
        assert.equal(v.allow?.length, 0);
    });

    it("rejects malformed non-string entries that aren't legacy shapes", () => {
        assert.throws(
            () =>
                validateCommandPermissions(
                    {
                        mode: "ask",
                        rules: [null, { kind: "regex", command: ".*" }],
                    },
                    "t",
                ),
            /rules\[\d+\] must be a string pattern/,
        );
    });
});

describe("command permission canonical configuration", () => {
    it("uses an explicit allow list instead of resurrecting legacy rules", () => {
        assert.deepEqual(
            validateCommandPermissions(
                { mode: "ask", allow: [], rules: ["git push *"], deny: ["bash *"] },
                "t",
            ),
            {
                mode: "ask",
                allow: [],
                deny: ["bash *"],
            },
        );
    });

    it("keeps canonical blacklist wrappers and authorized directories", () => {
        assert.deepEqual(
            validateCommandPermissions(
                {
                    mode: "auto",
                    allow: ["bash *", "git diff"],
                    deny: [" bash * ", "bash *"],
                    allowedDirectories: [" /workspace/extra ", "/workspace/extra"],
                },
                "t",
            ),
            {
                mode: "auto",
                allow: ["git diff"],
                deny: ["bash *"],
                allowedDirectories: ["/workspace/extra"],
            },
        );
    });

    it("rejects invalid authorized directory lists", () => {
        for (const allowedDirectories of [
            "/workspace",
            ["relative/path"],
            [""],
            [42],
            ["/workspace\0bad"],
        ]) {
            assert.throws(
                () => validateCommandPermissions({ mode: "ask", allowedDirectories }, "t"),
                /allowedDirectories/,
            );
        }
    });
});

describe("command permission edits", () => {
    useTempTacoHome("permission-edits");
    it("applies permission edits to the latest disk lists without restoring stale rules", () => {
        saveGlobalConfig({
            commandPermissions: {
                mode: "ask",
                allow: ["git diff"],
                deny: ["git reset *"],
                allowedDirectories: ["/workspace"],
            },
        });
        saveGlobalConfig({ commandPermissionsEdit: { addAllow: ["pnpm test"] } });
        saveGlobalConfig({ commandPermissionsEdit: { addDeny: ["git push *"] } });
        const next = saveGlobalConfig({
            commandPermissionsEdit: { mode: "auto", removeAllow: ["git diff"] },
        });
        assert.deepEqual(next.commandPermissions, {
            mode: "auto",
            allow: ["pnpm test"],
            deny: ["git reset *", "git push *"],
            allowedDirectories: ["/workspace"],
        });
    });
    it("rejects malformed edits without changing disk configuration", () => {
        const before = saveGlobalConfig({
            commandPermissions: { mode: "ask", allow: [], deny: [] },
        });
        assert.throws(() =>
            saveGlobalConfig({ commandPermissionsEdit: { addDeny: "git *" } } as never),
        );
        assert.throws(() =>
            saveGlobalConfig({ commandPermissionsEdit: { mode: "unsafe" } } as never),
        );
        assert.deepEqual(saveGlobalConfig({}).commandPermissions, before.commandPermissions);
    });
});

describe("validateMcpServers", () => {
    it("returns undefined for nullish input", () => {
        assert.equal(validateMcpServers(undefined, "t"), undefined);
    });

    it("rejects non-array input", () => {
        assert.throws(() => validateMcpServers({}, "t"), /must be an array/);
        assert.throws(() => validateMcpServers("x", "t"), /must be an array/);
    });

    it("rejects non-object entries", () => {
        assert.throws(() => validateMcpServers([null, "x"], "t"), /entry must be an object/);
    });

    it("rejects an id with illegal characters", () => {
        assert.throws(
            () =>
                validateMcpServers([{ id: "my server", transport: "stdio", command: "echo" }], "t"),
            /id must match/,
        );
        assert.throws(
            () => validateMcpServers([{ id: "中文", transport: "stdio", command: "echo" }], "t"),
            /id must match/,
        );
        assert.throws(
            () => validateMcpServers([{ id: "", transport: "stdio", command: "echo" }], "t"),
            /id must match/,
        );
    });

    it("rejects duplicate ids", () => {
        assert.throws(
            () =>
                validateMcpServers(
                    [
                        { id: "a", transport: "stdio", command: "echo" },
                        { id: "a", transport: "stdio", command: "echo" },
                    ],
                    "t",
                ),
            /duplicate id a/,
        );
    });

    it("rejects an unknown transport", () => {
        assert.throws(
            () => validateMcpServers([{ id: "a", transport: "sse", command: "echo" }], "t"),
            /transport must be "stdio" or "http"/,
        );
    });

    it("requires a non-empty command for stdio", () => {
        assert.throws(
            () => validateMcpServers([{ id: "a", transport: "stdio" }], "t"),
            /stdio server needs a non-empty command/,
        );
    });

    it("requires a valid url for http", () => {
        assert.throws(
            () => validateMcpServers([{ id: "a", transport: "http" }], "t"),
            /http server needs a non-empty url/,
        );
        assert.throws(
            () => validateMcpServers([{ id: "a", transport: "http", url: "not a url" }], "t"),
            /url must be a valid URL/,
        );
    });

    it("accepts a valid http server", () => {
        const out = validateMcpServers(
            [{ id: "a", transport: "http", url: "https://example.com/mcp" }],
            "t",
        );
        assert.equal(out?.[0].url, "https://example.com/mcp");
    });

    it("rejects a non-positive timeoutMs", () => {
        assert.throws(
            () =>
                validateMcpServers(
                    [{ id: "a", transport: "stdio", command: "echo", timeoutMs: 0 }],
                    "t",
                ),
            /timeoutMs must be a positive number/,
        );
        assert.throws(
            () =>
                validateMcpServers(
                    [{ id: "a", transport: "stdio", command: "echo", timeoutMs: -5 }],
                    "t",
                ),
            /timeoutMs must be a positive number/,
        );
    });

    it("rejects alwaysLoaded that is not a non-empty-string array", () => {
        assert.throws(
            () =>
                validateMcpServers(
                    [{ id: "a", transport: "stdio", command: "echo", alwaysLoaded: [1, 2] }],
                    "t",
                ),
            /alwaysLoaded must be a non-empty-string array/,
        );
        assert.throws(
            () =>
                validateMcpServers(
                    [{ id: "a", transport: "stdio", command: "echo", alwaysLoaded: "x" }],
                    "t",
                ),
            /alwaysLoaded must be a non-empty-string array/,
        );
    });

    it("keeps optional fields on a full valid entry", () => {
        const out = validateMcpServers(
            [
                {
                    id: "gh",
                    transport: "stdio",
                    command: "npx",
                    args: ["-y", "mcp-server-github"],
                    env: { TOKEN: "t" },
                    cwd: "/tmp",
                    timeoutMs: 5000,
                    alwaysLoaded: ["list_issues"],
                },
            ],
            "t",
        );
        assert.equal(out?.[0].args?.[0], "-y");
        assert.equal(out?.[0].cwd, "/tmp");
        assert.deepEqual(out?.[0].alwaysLoaded, ["list_issues"]);
    });
});
