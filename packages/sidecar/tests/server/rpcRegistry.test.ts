/**
 * RPC registry closure test — protects the contract between
 * `@taco-ai/shared` `RPC` constants and the actual `registerMethod(...)`
 * call sites in sidecar handlers.
 *
 * Three guarantees:
 *   1. Closure — every name in `RPC` is registered (no orphan constants).
 *   2. Coverage — every registered method comes from `RPC` (no string
 *      literals slipped back in).
 *   3. Namespace integrity — every registered name lives under a known
 *      namespace prefix (catches typos like `"session.Foo"` that pass the
 *      equality check).
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { RPC } from "@taco-ai/shared";

import { listRegisteredMethods } from "../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../src/server/methods.ts";

const NAMESPACES = [
    "workspace",
    "session",
    "command_permission",
    "providers",
    "provider",
    "imPolicy",
    "tools",
    "agents",
    "skills",
    "skill",
    "checkpoints",
    "memory",
    "mcp",
    "settings",
    "extensions",
    "channels",
    // PR4: jobs.* lives in the scheduler module rather than `@taco-ai/shared`
    // (the package's import surface is intentionally narrow). The namespace
    // closure test allows it here; UI-side drift is caught by an integration
    // test that imports the same constants.
    "jobs",
];

/**
 * `methodRegistry` is a module-level singleton Map, and sibling test files
 * (commandIdempotency, initialize) register `test.*` probes at import time.
 * Under the current per-file-process runner they never reach us, but the
 * closure assertions below would break the moment the suite moves to a
 * shared-process runner — so filter the probes out explicitly rather than
 * relying on process isolation.
 */
const isTestProbe = (name: string) => name.startsWith("test.");

describe("RPC registry closure", () => {
    let registered: Set<string>;

    before(() => {
        registerBuiltinMethods();
        registered = new Set(listRegisteredMethods().filter((n) => !isTestProbe(n)));
    });

    it("every RPC.* constant is registered (no orphans)", () => {
        const constantValues = new Set<string>(Object.values(RPC));
        const missing = [...constantValues].filter((v) => !registered.has(v));
        assert.deepEqual(missing, [], `orphan RPC constants: ${missing.join(", ")}`);
    });

    it("every registered method comes from RPC.* or JOBS_RPC (no string literals)", async () => {
        const { JOBS_RPC } = await import("../../src/scheduler/jobsRpc.ts");
        const constantValues = new Set<string>([...Object.values(RPC), ...Object.values(JOBS_RPC)]);
        const stray = [...registered].filter((v) => !constantValues.has(v));
        assert.deepEqual(stray, [], `unregistered method names: ${stray.join(", ")}`);
    });

    it("every registered method lives under a known namespace", () => {
        const stray = [...registered].filter((name) => {
            // `initialize` is its own namespace, no dot prefix.
            if (name === "initialize") return false;
            return !NAMESPACES.some((ns) => name === ns || name.startsWith(`${ns}.`));
        });
        assert.deepEqual(stray, [], `namespaced violations: ${stray.join(", ")}`);
    });

    it("registered method count matches RPC + JOBS_RPC constant count", async () => {
        const { JOBS_RPC } = await import("../../src/scheduler/jobsRpc.ts");
        const expected = Object.values(RPC).length + Object.values(JOBS_RPC).length;
        assert.equal(registered.size, expected);
    });
});
