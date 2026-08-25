import assert from "node:assert/strict";
import test from "node:test";
import {
    controlSocketPath,
    defaultRuntimeDir,
    ndjsonSocketPath,
    resolveTacoRuntimeDir,
    runtimePidFile,
} from "../lib/paths.ts";

test("explicit runtime directory owns all daemon coordination paths", () => {
    const runtime = resolveTacoRuntimeDir("/Users/test/.taco", "/Users/test/.taco-dev/run");
    assert.equal(runtime, "/Users/test/.taco-dev/run");
    assert.equal(ndjsonSocketPath(runtime), "/Users/test/.taco-dev/run/sidecar.sock");
    assert.equal(controlSocketPath(runtime), "/Users/test/.taco-dev/run/sidecar-ctl.sock");
    assert.equal(runtimePidFile(runtime), "/Users/test/.taco-dev/run/sidecar.pid");
});

test("blank runtime override defaults to the shared home run directory", () => {
    assert.equal(defaultRuntimeDir("/profiles/team-a"), "/profiles/team-a/run");
    assert.equal(resolveTacoRuntimeDir("/profiles/team-a", "  "), "/profiles/team-a/run");
});
