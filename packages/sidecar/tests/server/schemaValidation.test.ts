/**
 * Schema validation tests — cover the typebox schema plumbing wired into
 * `registerMethod` + `handleRpcRequest`.
 *
 * IMPORTANT: every registered schema is currently a `Type.Any()` /
 * `Type.Unknown()` placeholder, and those accept ANY value — so the
 * validation gate rejects nothing in production today. These tests
 * therefore split into two groups:
 *
 *   - Plumbing that is genuinely load-bearing now: schema coverage across
 *     all registered methods, and JSON-pointer decoding.
 *   - A pinned characterization of the placeholder behaviour, so that
 *     tightening a schema makes this file fail loudly instead of silently
 *     passing. See `placeholder schemas reject nothing (characterization)`.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { RPC } from "@taco-ai/shared";
import { Value } from "typebox/value";

import { getRegisteredMethod, listRegisteredMethods } from "../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../src/server/methods.ts";
import { parseJsonPointer } from "../../src/server/validation.ts";

/**
 * Sibling test files register `test.*` probes into the module-level registry
 * singleton at import time. Filter them so these assertions survive a move to
 * a shared-process test runner. Mirrors rpcRegistry.test.ts.
 */
const isTestProbe = (name: string) => name.startsWith("test.");
const builtinMethods = () => listRegisteredMethods().filter((n) => !isTestProbe(n));

describe("RPC schema coverage", () => {
    before(() => {
        registerBuiltinMethods();
    });

    it("every registered method has a schema attached", () => {
        const missing = builtinMethods().filter(
            (name) => !getRegisteredMethod(name)?.options.schema,
        );
        assert.deepEqual(missing, [], `methods missing schema: ${missing.join(", ")}`);
    });

    it("RPC constants map 1:1 to registered methods", () => {
        assert.deepEqual(builtinMethods(), Object.values(RPC).sort());
    });
});

describe("JSON pointer decoding", () => {
    it("decodes pointer tokens and RFC 6901 escapes", () => {
        assert.deepEqual(parseJsonPointer("/foo"), ["foo"]);
        assert.deepEqual(parseJsonPointer("/foo/bar"), ["foo", "bar"]);
        assert.deepEqual(parseJsonPointer("/attachments/0/url"), ["attachments", "0", "url"]);
        // ~1 → "/", ~0 → "~"
        assert.deepEqual(parseJsonPointer("/a~1b/c~0d"), ["a/b", "c~d"]);
    });

    it("returns [] for pointers that are not rooted at a token", () => {
        // Covers typebox reporting root-level errors with an empty instancePath.
        assert.deepEqual(parseJsonPointer(""), []);
        assert.deepEqual(parseJsonPointer("/"), []);
    });
});

describe("validation pipeline (with a real strict schema)", () => {
    // The registered schemas cannot exercise the reject path, so use a
    // hand-written strict schema to prove Value.Errors → parseJsonPointer
    // produces a usable wire `issues[]` shape.
    const strictSchema = {
        type: "object",
        required: ["workspace", "sessionId"],
        properties: {
            workspace: { type: "string" },
            sessionId: { type: "string" },
            nested: {
                type: "object",
                properties: { count: { type: "number" } },
            },
        },
    } as const;

    it("reports a missing required field", () => {
        const errors = Value.Errors(strictSchema, { workspace: "/tmp" });
        assert.ok(errors.length > 0, "missing sessionId should produce an error");
    });

    it("reports a nested type mismatch with a decodable path", () => {
        const errors = [
            ...Value.Errors(strictSchema, {
                workspace: "/tmp",
                sessionId: "s1",
                nested: { count: "not-a-number" },
            }),
        ];
        assert.ok(errors.length > 0, "wrong nested type should produce an error");
        const paths = errors.map((e) => parseJsonPointer(e.instancePath));
        assert.ok(
            paths.some((p) => p.includes("nested") && p.includes("count")),
            `expected a nested/count path, got ${JSON.stringify(paths)}`,
        );
    });

    it("accepts a fully valid object", () => {
        const errors = Value.Errors(strictSchema, {
            workspace: "/tmp",
            sessionId: "s1",
            nested: { count: 3 },
        });
        assert.equal([...errors].length, 0);
    });
});

describe("placeholder schemas reject nothing (characterization)", () => {
    before(() => {
        registerBuiltinMethods();
    });

    // These assertions pin the CURRENT no-op behaviour on purpose. When a
    // schema is tightened to Type.Object({...}), the matching case below will
    // start failing — that failure is the signal to update this file and the
    // schema's JSDoc together, not to loosen the schema again.
    const nonsenseInputs: Array<[string, unknown]> = [
        ["null", null],
        ["undefined", undefined],
        ["a number", 42],
        ["a string", "not-params"],
        ["an array", [1, 2, 3]],
        ["an empty object", {}],
    ];

    for (const method of [RPC.initialize, RPC.sessionPrompt, RPC.sessionCreate]) {
        for (const [label, input] of nonsenseInputs) {
            it(`${method} still accepts ${label}`, () => {
                const schema = getRegisteredMethod(method)?.options.schema;
                assert.ok(schema, `${method} must have a schema`);
                const errors = [...Value.Errors(schema, input)];
                assert.equal(
                    errors.length,
                    0,
                    `${method} unexpectedly rejected ${label} — if this schema was intentionally tightened, update this characterization test and the schema's JSDoc note`,
                );
            });
        }
    }
});
