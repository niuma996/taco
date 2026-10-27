/**
 * RPC contract table tests — the table is the single source of truth for
 * every wire method, so its own invariants are what everything else rests
 * on.
 *
 * The compile-time half of this (a method name that disagrees between the
 * two tables, a schema that rejects a value the contract declares legal) is
 * checked by the type checker through the `contractKeysMatchRpcKeys` and
 * `schemasAgreeWithParams` assertions in `@taco-ai/protocol`. Those are
 * compile-time constants, not runtime values, so what runs here is the
 * runtime half: that the tables agree in content and that every name is
 * unique and well-formed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { RPC, type RpcContractKey, rpcContract, rpcSchemas } from "@taco-ai/protocol";

const contractKeys = Object.keys(rpcContract) as RpcContractKey[];
const wireNames = Object.values(RPC);

test("every contract key has a params schema", () => {
    for (const key of contractKeys) {
        assert.ok(rpcSchemas[key], `missing schema for ${key}`);
    }
});

test("the schema table has no key the contract table lacks", () => {
    // The compile-time assertion covers the other direction; this catches a
    // schema left behind after a method was renamed or removed.
    const schemaKeys = Object.keys(rpcSchemas);
    const orphans = schemaKeys.filter((key) => !contractKeys.includes(key as RpcContractKey));
    assert.deepEqual(orphans, [], `schemas without a contract row: ${orphans.join(", ")}`);
});

test("wire method names are unique", () => {
    const seen = new Set<string>();
    for (const name of wireNames) {
        assert.equal(seen.has(name), false, `duplicate wire name: ${name}`);
        seen.add(name);
    }
});

test("wire method names follow the namespace.action convention", () => {
    for (const name of wireNames) {
        // `initialize` is the bootstrap method and carries no namespace.
        if (name === "initialize") continue;
        const parts = name.split(".");
        assert.ok(parts.length >= 2, `${name} is not namespace.action`);
        // Every segment after the namespace is camelCase — no underscores.
        for (const segment of parts.slice(1)) {
            assert.equal(segment.includes("_"), false, `${name} has an underscored segment`);
        }
    }
});

test("the constant key mirrors the wire name's casing", () => {
    // `skills.content` predates the convention and keeps its singular key;
    // renaming it would break the wire contract for no gain.
    const exceptions = new Set(["skillContent"]);
    for (const key of contractKeys) {
        if (exceptions.has(key)) continue;
        const wire = RPC[key];
        const camel = wire
            .split(".")
            .map((segment, index) =>
                index === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1),
            )
            .join("");
        assert.equal(key, camel, `${key} does not mirror ${wire}`);
    }
});

test("typed request builder preserves wire names and payloads", async () => {
    const { createRpcRequest, asWorkspaceId } = await import("@taco-ai/protocol");
    const params = { workspace: asWorkspaceId("/w"), initialPrompt: "hello" };
    assert.deepEqual(createRpcRequest("1", RPC.sessionCreate, params), {
        id: "1",
        method: "session.create",
        params,
    });
    assert.equal(
        JSON.stringify(createRpcRequest("2", RPC.workspaceList, undefined)),
        '{"id":"2","method":"workspace.list"}',
    );
});
