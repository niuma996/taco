/**
 * validateMcpServers — config validation for the mcpServers field.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { validateMcpServers } from "../../src/config/config.ts";

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
