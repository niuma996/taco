import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
    controlSocketPath,
    defaultRuntimeDir,
    ndjsonSocketPath,
    resolveTacoRuntimeDir,
    runtimePidFile,
    windowsPipeSlug,
} from "../lib/paths.ts";

test("explicit runtime directory owns all daemon coordination paths", () => {
    const runtime = resolveTacoRuntimeDir("/Users/test/.taco", "/Users/test/.taco-dev/run");
    assert.equal(runtime, "/Users/test/.taco-dev/run");
    if (process.platform === "win32") {
        const slug = windowsPipeSlug(runtime);
        assert.equal(ndjsonSocketPath(runtime), `\\\\.\\pipe\\taco-sidecar-${slug}`);
        assert.equal(controlSocketPath(runtime), `\\\\.\\pipe\\taco-sidecar-ctl-${slug}`);
    } else {
        assert.equal(ndjsonSocketPath(runtime), "/Users/test/.taco-dev/run/sidecar.sock");
        assert.equal(controlSocketPath(runtime), "/Users/test/.taco-dev/run/sidecar-ctl.sock");
    }
    assert.equal(runtimePidFile(runtime), join(runtime, "sidecar.pid"));
});

test("blank runtime override defaults to the shared home run directory", () => {
    assert.equal(defaultRuntimeDir("/profiles/team-a"), join("/profiles/team-a", "run"));
    assert.equal(resolveTacoRuntimeDir("/profiles/team-a", "  "), join("/profiles/team-a", "run"));
});

test("windowsPipeSlug is stable across slash, case, trailing-sep, and verbatim prefixes", () => {
    const canonical = "C:\\Users\\test\\.taco-dev\\run";
    assert.equal(windowsPipeSlug(canonical), "3046aa052e73dbd5");
    assert.equal(windowsPipeSlug("c:/Users/test/.taco-dev/run"), "3046aa052e73dbd5");
    assert.equal(windowsPipeSlug("\\\\?\\C:\\Users\\test\\.taco-dev\\run"), "3046aa052e73dbd5");
    assert.equal(windowsPipeSlug("//?/C:/Users/test/.taco-dev/run"), "3046aa052e73dbd5");
    assert.equal(windowsPipeSlug("C:\\Users\\test\\.taco-dev\\run\\"), "3046aa052e73dbd5");
    assert.notEqual(windowsPipeSlug("C:\\Users\\test\\.taco\\run"), windowsPipeSlug(canonical));
});

test("windowsPipeSlug folds ASCII only, matching the Rust twin's make_ascii_lowercase", () => {
    assert.equal(
        windowsPipeSlug("C:\\Users\\ÜNDREA\\.taco-dev\\run"),
        windowsPipeSlug("c:\\users\\ÜNDREA\\.taco-dev\\run"),
    );
    assert.notEqual(
        windowsPipeSlug("C:\\Users\\ÜNDREA\\.taco-dev\\run"),
        windowsPipeSlug("C:\\Users\\ündrea\\.taco-dev\\run"),
    );
});
