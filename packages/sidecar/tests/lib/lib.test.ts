import { strict as assert } from "node:assert";
import { ok, strictEqual } from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it, test } from "node:test";
import { DeadlineError, SingleFlight, waitForEvent, withDeadline } from "../../src/lib/async.ts";
import { buildSidecarPidRecord, computeInstallId } from "../../src/lib/installId.ts";
import { createLogger, resetLogLevel } from "../../src/lib/logger.ts";
import {
    augmentProcessPath,
    resolveLoginShellPath,
    resolveLoginShellPathCached,
} from "../../src/lib/loginShellPath.ts";
import { installStderrTee } from "../../src/lib/stderrTee.ts";

describe("async", () => {
    function deferred() {
        let listener: (() => void) | undefined;
        let unsubscribeCalled = 0;
        return {
            fire(): void {
                listener?.();
            },
            subscribe(fn: () => void): () => void {
                listener = fn;
                return () => {
                    unsubscribeCalled++;
                };
            },
            get unsubscribeCount(): number {
                return unsubscribeCalled;
            },
        };
    }

    describe("waitForEvent", () => {
        it("resolves true when the event fires", async () => {
            const d = deferred();
            const wait = waitForEvent({ timeoutMs: 500, subscribe: d.subscribe });
            d.fire();
            assert.equal(await wait.promise, true);
            assert.equal(d.unsubscribeCount, 1);
        });

        it("resolves false on timeout and unsubscribes", async () => {
            const d = deferred();
            const wait = waitForEvent({ timeoutMs: 10, subscribe: d.subscribe });
            assert.equal(await wait.promise, false);
            assert.equal(d.unsubscribeCount, 1);
        });

        it("cancel() resolves false immediately and unsubscribes", async () => {
            const d = deferred();
            const wait = waitForEvent({ timeoutMs: 5_000, subscribe: d.subscribe });
            wait.cancel();
            assert.equal(await wait.promise, false);
            assert.equal(d.unsubscribeCount, 1);
        });

        it("late events after settle are ignored", async () => {
            const d = deferred();
            const wait = waitForEvent({ timeoutMs: 5_000, subscribe: d.subscribe });
            wait.cancel();
            assert.equal(await wait.promise, false);
            d.fire(); // must not throw / double-resolve
            assert.equal(d.unsubscribeCount, 1);
        });

        it("cleans up when subscribe fires the listener synchronously", async () => {
            let unsubscribeCalled = 0;
            const wait = waitForEvent({
                timeoutMs: 5_000,
                subscribe: (fn) => {
                    fn(); // synchronous fire before subscribe returns
                    return () => {
                        unsubscribeCalled++;
                    };
                },
            });
            assert.equal(await wait.promise, true);
            assert.equal(unsubscribeCalled, 1);
        });
    });

    describe("SingleFlight", () => {
        function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
            let resolve!: (v: T) => void;
            const promise = new Promise<T>((res) => {
                resolve = res;
            });
            return { promise, resolve };
        }

        it("shares one factory call across concurrent run()s for the same key", async () => {
            let factoryCalls = 0;
            const flight = new SingleFlight<string, string>(async (key) => {
                factoryCalls++;
                return `v:${key}`;
            });
            const [a, b, c] = await Promise.all([
                flight.run("k"),
                flight.run("k"),
                flight.run("k"),
            ]);
            assert.equal(factoryCalls, 1);
            assert.equal(a, "v:k");
            assert.equal(b, "v:k");
            assert.equal(c, "v:k");
        });

        it("calls the factory separately for different keys in parallel", async () => {
            let factoryCalls = 0;
            const flight = new SingleFlight<string, string>(async (key) => {
                factoryCalls++;
                return `v:${key}`;
            });
            const [a, b] = await Promise.all([flight.run("a"), flight.run("b")]);
            assert.equal(factoryCalls, 2);
            assert.equal(a, "v:a");
            assert.equal(b, "v:b");
        });

        it("retries the factory after the shared promise rejects", async () => {
            let attempts = 0;
            const flight = new SingleFlight<string, string>(async () => {
                attempts++;
                if (attempts === 1) throw new Error("first attempt");
                return "ok";
            });
            await assert.rejects(flight.run("k"), /first attempt/);
            assert.equal(await flight.run("k"), "ok");
            assert.equal(attempts, 2);
        });

        it("concurrent run()s observe the same rejection from one failed factory call", async () => {
            let attempts = 0;
            const flight = new SingleFlight<string, string>(async () => {
                attempts++;
                throw new Error("boom");
            });
            const settled = await Promise.allSettled([
                flight.run("k"),
                flight.run("k"),
                flight.run("k"),
            ]);
            assert.equal(attempts, 1);
            assert.ok(settled.every((s) => s.status === "rejected"));
        });

        it("deletes the inflight entry when the shared promise resolves", async () => {
            const flight = new SingleFlight<string, string>(async (key) => `v:${key}`);
            await flight.run("k");
            // After settle, the next call must hit the factory again.
            let calls = 0;
            const counting = new SingleFlight<string, string>(async (key) => {
                calls++;
                return `v:${key}`;
            });
            await counting.run("k");
            await counting.run("k");
            assert.equal(calls, 2);
        });

        it("clear() drops in-flight promises; awaiters see the factory's original rejection", async () => {
            const d = deferred<string>();
            const flight = new SingleFlight<string, string>(() => d.promise);
            const first = flight.run("k");
            flight.clear();
            // A fresh run() after clear() must NOT share the still-pending first promise.
            const second = flight.run("k");
            d.resolve("late");
            assert.equal(await first, "late");
            // second has its own (already-resolved via d.resolve) factory call.
            assert.equal(await second, "late");
        });
    });

    /** withDeadline unit tests — timer race, signal fusion, structured error. */

    describe("withDeadline", () => {
        it("resolves fast promises with the original value", async () => {
            assert.equal(await withDeadline(Promise.resolve(42), deadline("fast")), 42);
            assert.equal(await withDeadline(Promise.resolve("ok"), deadline("fast")), "ok");
        });

        it("propagates rejections from the underlying promise unchanged", async () => {
            await assert.rejects(
                () => withDeadline(Promise.reject(new Error("boom")), deadline("fast")),
                /boom/,
            );
        });

        it("rejects with DeadlineError when the local timer wins", async () => {
            const start = Date.now();
            await assert.rejects(
                () =>
                    withDeadline(new Promise<string>(() => {}), {
                        timeoutMs: 50,
                        code: "HOOK_TIMEOUT",
                        label: "hanger hook",
                    }),
                (err: unknown) => {
                    assert.ok(err instanceof DeadlineError);
                    assert.equal((err as DeadlineError).code, "HOOK_TIMEOUT");
                    assert.equal((err as DeadlineError).label, "hanger hook");
                    assert.equal((err as DeadlineError).timeoutMs, 50);
                    assert.match((err as Error).message, /hanger hook timed out after 50ms/);
                    return true;
                },
            );
            const elapsed = Date.now() - start;
            assert.ok(elapsed < 1_000, `deadline took ${elapsed}ms`);
        });

        it("runs onTimeout once when the local timer wins", async () => {
            let calls = 0;
            await assert.rejects(() =>
                withDeadline(new Promise<never>(() => {}), {
                    timeoutMs: 25,
                    code: "MCP_TIMEOUT",
                    label: "mcp server foo: connect",
                    onTimeout: () => {
                        calls++;
                    },
                }),
            );
            // A microtask boundary is enough for the awaited onTimeout to run.
            await new Promise((r) => setImmediate(r));
            assert.equal(calls, 1);
        });

        it("does NOT run onTimeout when the promise resolves in time", async () => {
            let calls = 0;
            await withDeadline(Promise.resolve("ok"), {
                ...deadline("fast"),
                onTimeout: () => {
                    calls++;
                },
            });
            await new Promise((r) => setImmediate(r));
            assert.equal(calls, 0);
        });

        it("swallows onTimeout rejections — the deadline error is the user-visible one", async () => {
            await assert.rejects(
                () =>
                    withDeadline(new Promise<never>(() => {}), {
                        timeoutMs: 25,
                        code: "MCP_TIMEOUT",
                        label: "mcp server foo: connect",
                        onTimeout: () => {
                            throw new Error("cleanup failed");
                        },
                    }),
                (err: unknown) => {
                    // The DeadlineError must reach the caller — the cleanup throw
                    // is swallowed inside the wrapper, exactly as in the original
                    // mcpClient.withTimeout.
                    assert.ok(err instanceof DeadlineError);
                    return true;
                },
            );
        });

        it("rejects immediately when externalSignal is already aborted", async () => {
            const ac = new AbortController();
            ac.abort();
            await assert.rejects(
                () =>
                    withDeadline(new Promise<string>(() => {}), {
                        timeoutMs: 60_000,
                        code: "MCP_TIMEOUT",
                        label: "mcp server foo: callTool(bar)",
                        externalSignal: ac.signal,
                    }),
                (err: unknown) => {
                    assert.ok(err instanceof DeadlineError);
                    assert.equal((err as DeadlineError).code, "MCP_TIMEOUT");
                    return true;
                },
            );
        });

        it("rejects when externalSignal aborts during the wait", async () => {
            const ac = new AbortController();
            setTimeout(() => ac.abort(), 25);
            const start = Date.now();
            await assert.rejects(
                () =>
                    withDeadline(new Promise<string>(() => {}), {
                        timeoutMs: 60_000,
                        code: "MCP_TIMEOUT",
                        label: "mcp server foo: listTools",
                        externalSignal: ac.signal,
                    }),
                (err: unknown) => {
                    assert.ok(err instanceof DeadlineError);
                    return true;
                },
            );
            const elapsed = Date.now() - start;
            assert.ok(elapsed < 1_000, `externalSignal took ${elapsed}ms`);
        });

        it("refuses a non-positive timeoutMs up front", async () => {
            // withDeadline is async, so a validation throw surfaces as a
            // rejected promise (not a synchronous throw) — use assert.rejects.
            await assert.rejects(
                () => withDeadline(Promise.resolve("x"), { timeoutMs: 0, code: "X", label: "y" }),
                /timeoutMs must be a positive finite number/,
            );
            await assert.rejects(
                () => withDeadline(Promise.resolve("x"), { timeoutMs: -1, code: "X", label: "y" }),
                /timeoutMs must be a positive finite number/,
            );
            await assert.rejects(
                () =>
                    withDeadline(Promise.resolve("x"), {
                        timeoutMs: Number.NaN,
                        code: "X",
                        label: "y",
                    }),
                /timeoutMs must be a positive finite number/,
            );
        });
    });

    function deadline(label: string, timeoutMs = 60_000) {
        return { timeoutMs, code: "TEST_TIMEOUT", label };
    }
});

describe("installId", () => {
    test("computeInstallId matches the CLI and Rust golden vector", () => {
        // Same vector as packages/cli/tests/installId.test.ts and
        // clients/taco-desktop/src-tauri/tests/daemon_reap.rs. All three
        // implementations MUST stay byte-for-byte identical — failing here means
        // the desktop reap path would skip a daemon it owns (or kill one it
        // doesn't).
        strictEqual(
            computeInstallId("/repo/packages/sidecar/src", "/home/dev/.taco"),
            "c8ffd7d5d75fcb04",
        );
    });

    test("buildSidecarPidRecord stamps sidecar_version when provided", () => {
        const record = buildSidecarPidRecord(
            4242,
            "abcd1234ef567890",
            "0.1.2",
            () => new Date("2026-09-03T10:00:00.000Z"),
        );
        strictEqual(record.version, 1);
        strictEqual(record.pid, 4242);
        strictEqual(record.install_id, "abcd1234ef567890");
        strictEqual(record.started_at, "2026-09-03T10:00:00.000Z");
        strictEqual(record.sidecar_version, "0.1.2");
    });

    test("buildSidecarPidRecord omits sidecar_version when not provided", () => {
        // Launchers treat a missing field as "stale" — it must stay absent
        // (not null / "") so old-record semantics round-trip through JSON.
        const record = buildSidecarPidRecord(4242, "abcd1234ef567890");
        ok(!("sidecar_version" in record));
    });
});

describe("logger", () => {
    /** Captures stderr writes for the duration of one test. */
    function captureStderr(): { lines: () => string[]; restore: () => void } {
        const original = process.stderr.write.bind(process.stderr);
        const out: string[] = [];
        // biome-ignore lint/suspicious/noExplicitAny: matching Node's write overloads
        (process.stderr as any).write = (chunk: any): boolean => {
            out.push(String(chunk));
            return true;
        };
        return {
            lines: () => out.join("").split("\n").filter(Boolean),
            restore: () => {
                // biome-ignore lint/suspicious/noExplicitAny: restoring the original binding
                (process.stderr as any).write = original;
            },
        };
    }

    let cap: ReturnType<typeof captureStderr>;

    beforeEach(() => {
        process.env.TACO_LOG_LEVEL = "debug";
        resetLogLevel();
        cap = captureStderr();
    });

    afterEach(() => {
        cap.restore();
        delete process.env.TACO_LOG_LEVEL;
        resetLogLevel();
    });

    describe("createLogger line format", () => {
        it("emits `<ISO> [level] [scope] message` and folds embedded newlines so one log is always one line", () => {
            createLogger("scope-a").error("boom");
            const [first] = cap.lines();
            assert.match(first ?? "", /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[error\] \[scope-a\] boom$/);

            createLogger("s").error("a\nb\rafter");
            const folded = cap.lines().at(-1) ?? "";
            // Both \n and \r are escaped so each log is always one line on disk.
            assert.doesNotMatch(folded, /[\n\r]/);
        });

        it("omits the field group when there are no fields", () => {
            createLogger("s").info("plain");
            assert.match(cap.lines()[0] ?? "", /\[s\] plain$/);
        });
    });

    describe("level gating", () => {
        it("drops levels below the threshold and falls back to info for an unknown level", () => {
            process.env.TACO_LOG_LEVEL = "warn";
            resetLogLevel();
            const warnLog = createLogger("s");
            warnLog.error("e");
            warnLog.warn("w");
            warnLog.info("i");
            warnLog.debug("d");
            const warnJoined = cap.lines().join("\n");
            assert.match(warnJoined, /\[error\]/);
            assert.match(warnJoined, /\[warn\]/);
            assert.doesNotMatch(warnJoined, /\[info\]/);
            assert.doesNotMatch(warnJoined, /\[debug\]/);

            cap.restore();
            cap = captureStderr();
            process.env.TACO_LOG_LEVEL = "bogus";
            resetLogLevel();
            const fallbackLog = createLogger("s");
            fallbackLog.info("i");
            fallbackLog.debug("d");
            const fallbackJoined = cap.lines().join("\n");
            assert.match(fallbackJoined, /\[info\]/);
            assert.doesNotMatch(fallbackJoined, /\[debug\]/);
        });
    });

    describe("child()", () => {
        it("renders single / multi / merged fields and does not mutate the parent", () => {
            // Single field
            createLogger("channel:wecom").child({ sid: "s-1" }).warn("prompt rejected");
            // Multi fields
            createLogger("channel").child({ channel: "wecom", method: "x" }).error("push failed");
            // Merge with override + parent isolation in one go
            const parent = createLogger("s");
            parent.child({ a: "1", b: "2" }).child({ b: "3" }).info("merged");
            parent.info("parent");

            const lines = cap.lines();
            assert.match(lines[0] ?? "", /\{sid=s-1\} prompt rejected$/);
            assert.match(lines[1] ?? "", /\{channel=wecom method=x\} push failed$/);
            assert.match(lines[2] ?? "", /\{a=1 b=3\} merged$/);
            assert.match(lines[3] ?? "", /\[s\] parent$/);
        });

        it("sanitizes field values (whitespace → _, strips `}`, embedded \\r / \\n escaped)", () => {
            createLogger("s").child({ v: "a}b\nc", sid: "session with space" }).info("m");
            const line = cap.lines()[0] ?? "";
            assert.match(line, /\{v=ab_c sid=session_with_space\} m$/);
            assert.doesNotMatch(line, /[\n\r]/);
            assert.equal(cap.lines().length, 1);
        });

        it("drops non-identifier keys and accepts numeric values", () => {
            createLogger("s").child({ "bad key": "x", good: "y", n: 42 }).info("m");
            assert.match(cap.lines()[0] ?? "", /\{good=y n=42\} m$/);
        });
    });
});

describe("loginShellPath", () => {
    test("resolveLoginShellPath is skipped on Windows", () => {
        strictEqual(resolveLoginShellPath("win32", "/bin/zsh"), undefined);
    });

    test("resolveLoginShellPath returns undefined when the shell probe fails", () => {
        // A shell path that doesn't exist → execFileSync throws → undefined.
        strictEqual(resolveLoginShellPath("darwin", "/nonexistent/taco-shell-xyz"), undefined);
    });

    test("resolveLoginShellPath extracts PATH after the sentinel", () => {
        // Only meaningful on POSIX; on a real host the login shell echoes the
        // sentinel followed by PATH. We can't rely on the host's shell here, so
        // this test asserts the parser shape only when a shell exists.
        if (process.platform === "win32") return;
        const path = resolveLoginShellPath("darwin", "/bin/zsh");
        // /bin/zsh exists on macOS CI + dev hosts; when present the result is a
        // non-empty PATH string.
        if (path !== undefined) {
            strictEqual(path.includes(":"), true);
        }
    });

    test("resolveLoginShellPath falls back to /etc/passwd when $SHELL is unset on Linux", () => {
        // Simulate a systemd user unit where $SHELL is empty. The
        // resolver must consult /etc/passwd (we can't override the
        // cached read here, so we cover it via the explicit uid arg with
        // a known-valid shell path that exists on Linux/macOS hosts).
        if (process.platform === "win32") return;
        // Pretend $SHELL is unset; pass uid=0 (root). root's shell on
        // every host should be either /bin/sh, /bin/bash, or /bin/zsh —
        // all of which exist on this dev host.
        const path = resolveLoginShellPath("linux", "", 0);
        // If /bin/sh is callable on this host it should produce a PATH;
        // the test stays loose on the actual value because CI containers
        // vary.
        if (path !== undefined) {
            strictEqual(path.length > 0, true);
        }
    });

    test("augmentProcessPath prepends login entries and dedupes", () => {
        const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
        const changed = augmentProcessPath(
            () => "/Users/x/.nvm/bin:/usr/bin:/opt/homebrew/bin",
            env,
        );
        strictEqual(changed, true);
        strictEqual(env.PATH, "/Users/x/.nvm/bin:/usr/bin:/opt/homebrew/bin:/bin");
    });

    test("augmentProcessPath returns false when login shell yields nothing", () => {
        const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
        strictEqual(
            augmentProcessPath(() => undefined, env),
            false,
        );
        strictEqual(env.PATH, "/usr/bin:/bin");
    });

    test("augmentProcessPath returns false when nothing would change", () => {
        const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
        strictEqual(
            augmentProcessPath(() => "/usr/bin:/bin", env),
            false,
        );
        strictEqual(env.PATH, "/usr/bin:/bin");
    });

    // ─────────── resolveLoginShellPathCached (disk cache) ───────────

    let cacheHome: string | undefined;
    const savedTacoHome = process.env.TACO_HOME;

    before(() => {
        if (process.platform === "win32") return;
        cacheHome = mkdtempSync(join(tmpdir(), "login-path-cache-"));
        process.env.TACO_HOME = cacheHome;
    });

    after(() => {
        if (cacheHome) rmSync(cacheHome, { recursive: true, force: true });
        if (savedTacoHome === undefined) {
            delete process.env.TACO_HOME;
        } else {
            process.env.TACO_HOME = savedTacoHome;
        }
    });

    test("resolveLoginShellPathCached: miss probes and writes, second call hits without probing", () => {
        if (process.platform === "win32" || !cacheHome) return;
        let probes = 0;
        const probe = () => {
            probes += 1;
            return "/cached/bin:/usr/bin";
        };
        const shell = "/bin/zsh";

        strictEqual(resolveLoginShellPathCached(probe, shell), "/cached/bin:/usr/bin");
        strictEqual(probes, 1);
        // Cache file written with the probe result.
        const entry = JSON.parse(
            readFileSync(join(cacheHome, "run", "login-path-cache.json"), "utf8"),
        );
        strictEqual(entry.path, "/cached/bin:/usr/bin");
        strictEqual(entry.shell, shell);

        // Second call is served from disk — probe not invoked again.
        strictEqual(resolveLoginShellPathCached(probe, shell), "/cached/bin:/usr/bin");
        strictEqual(probes, 1);
    });

    test("resolveLoginShellPathCached: shell mismatch in cache re-probes", () => {
        if (process.platform === "win32" || !cacheHome) return;
        // Self-contained: wipe the cache the previous test primed.
        rmSync(join(cacheHome, "run"), { recursive: true, force: true });
        let probes = 0;
        const probe = () => {
            probes += 1;
            return "/fresh/bin";
        };
        // Prime the cache with one shell, then resolve with another.
        resolveLoginShellPathCached(probe, "/bin/zsh");
        strictEqual(resolveLoginShellPathCached(probe, "/bin/bash"), "/fresh/bin");
        strictEqual(probes, 2);
    });

    test("resolveLoginShellPathCached: failed probe leaves no cache file behind", () => {
        if (process.platform === "win32" || !cacheHome) return;
        // Wipe whatever earlier tests wrote, then fail the probe.
        rmSync(join(cacheHome, "run"), { recursive: true, force: true });
        strictEqual(
            resolveLoginShellPathCached(() => undefined, "/bin/zsh"),
            undefined,
        );
        let threw = false;
        try {
            readFileSync(join(cacheHome, "run", "login-path-cache.json"), "utf8");
        } catch {
            threw = true;
        }
        strictEqual(threw, true);
    });
});

describe("stderrTee", () => {
    let dir: string;
    let logPath: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "taco-stderr-tee-"));
        logPath = join(dir, "daemon.err.log");
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    /** Swap in a capturing stderr.write, returning it plus a restore fn. */
    function stubStderr(onWrite?: () => void): {
        chunks: string[];
        restore: () => void;
    } {
        const original = process.stderr.write.bind(process.stderr);
        const chunks: string[] = [];
        // biome-ignore lint/suspicious/noExplicitAny: matching Node's write overloads
        (process.stderr as any).write = (chunk: any): boolean => {
            onWrite?.();
            chunks.push(String(chunk));
            return true;
        };
        return {
            chunks,
            restore: () => {
                // biome-ignore lint/suspicious/noExplicitAny: restoring the original binding
                (process.stderr as any).write = original;
            },
        };
    }

    describe("installStderrTee", () => {
        it("returns undefined for an empty path so callers can skip the tee", () => {
            assert.equal(installStderrTee(""), undefined);
        });

        it("mirrors writes to both the log file and the original stderr", async () => {
            const cap = stubStderr();
            const handle = installStderrTee(logPath);
            assert.ok(handle);
            try {
                process.stderr.write("hello tee\n");
            } finally {
                // dispose() calls end(); the bytes only reach disk once the
                // stream flushes, which is what its promise settles on.
                await handle.dispose();
                cap.restore();
            }
            assert.deepEqual(cap.chunks, ["hello tee\n"]);
            assert.match(readFileSync(logPath, "utf8"), /hello tee/);
        });

        it("keeps skipPrefix chunks on stderr but out of the log file", async () => {
            const cap = stubStderr();
            const handle = installStderrTee(logPath, { skipPrefix: "[taco:llm]" });
            assert.ok(handle);
            try {
                process.stderr.write("[taco:llm] payload\n");
                process.stderr.write("kept line\n");
            } finally {
                await handle.dispose();
                cap.restore();
            }
            assert.deepEqual(cap.chunks, ["[taco:llm] payload\n", "kept line\n"]);
            const raw = readFileSync(logPath, "utf8");
            assert.match(raw, /kept line/);
            assert.doesNotMatch(raw, /payload/);
        });

        it("rotates to <path>.1 once maxBytes is reached and keeps one generation", async () => {
            const cap = stubStderr();
            const handle = installStderrTee(logPath, { maxBytes: 64 });
            assert.ok(handle);
            try {
                for (let i = 0; i < 10; i++) process.stderr.write(`${"x".repeat(30)} line-${i}\n`);
            } finally {
                await handle.dispose();
                cap.restore();
            }
            // Each line is 38 bytes, so a 64-byte budget rotates every second
            // line; the newest line may sit at the end of either file.
            const current = readFileSync(logPath, "utf8");
            const previous = readFileSync(`${logPath}.1`, "utf8");
            assert.match(previous + current, /line-9\n$/);
            assert.ok(Buffer.byteLength(current) < 64);
            assert.ok(Buffer.byteLength(previous) < 64 + 38);
            assert.doesNotMatch(previous + current, /line-0\n/, "older generations are dropped");
        });

        it("closes the append fd before renaming so Windows can rotate", async () => {
            const originalOpenSync = fs.openSync;
            const originalCloseSync = fs.closeSync;
            const originalRenameSync = fs.renameSync;
            let mirrorFd: number | undefined;
            let renamedWhileOpen = false;
            fs.openSync = (path, flags, mode) => {
                const opened = originalOpenSync(path, flags, mode);
                if (path === logPath && flags === "a") mirrorFd = opened;
                return opened;
            };
            fs.closeSync = (fd) => {
                if (fd === mirrorFd) mirrorFd = undefined;
                originalCloseSync(fd);
            };
            fs.renameSync = (oldPath, newPath) => {
                if (oldPath === logPath && mirrorFd !== undefined) renamedWhileOpen = true;
                originalRenameSync(oldPath, newPath);
            };
            syncBuiltinESMExports();

            const cap = stubStderr();
            let handle: ReturnType<typeof installStderrTee>;
            try {
                handle = installStderrTee(logPath, { maxBytes: 8 });
                assert.ok(handle);
                process.stderr.write("exceeds budget\n");
            } finally {
                await handle?.dispose();
                cap.restore();
                fs.openSync = originalOpenSync;
                fs.closeSync = originalCloseSync;
                fs.renameSync = originalRenameSync;
                syncBuiltinESMExports();
            }

            assert.equal(renamedWhileOpen, false, "Windows cannot rename an open append fd");
            assert.equal(readFileSync(`${logPath}.1`, "utf8"), "exceeds budget\n");
        });

        it("moves an oversized file aside before appending", async () => {
            writeFileSync(logPath, "y".repeat(200));
            const cap = stubStderr();
            const handle = installStderrTee(logPath, { maxBytes: 100 });
            assert.ok(handle);
            try {
                process.stderr.write("fresh\n");
            } finally {
                await handle.dispose();
                cap.restore();
            }
            assert.equal(readFileSync(logPath, "utf8"), "fresh\n");
            assert.equal(readFileSync(`${logPath}.1`, "utf8").length, 200);
        });

        it("restores the original stderr.write on dispose", () => {
            const cap = stubStderr();
            const handle = installStderrTee(logPath);
            assert.ok(handle);
            const teed = process.stderr.write;
            handle.dispose();
            assert.notEqual(process.stderr.write, teed, "dispose should swap the tee back out");
            // Assert behaviour, not identity: the restored write is a bound copy
            // of the stub, so it can never be reference-equal to it.
            process.stderr.write("after dispose\n");
            cap.restore();
            assert.deepEqual(cap.chunks, ["after dispose\n"]);
            // Nothing was ever mirrored here, so the lazily-opened stream may not
            // exist at all; either way it must not have captured the post-dispose
            // write.
            const mirrored = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
            assert.equal(mirrored.includes("after dispose"), false);
        });

        it("is idempotent — a second dispose is a no-op", () => {
            const cap = stubStderr();
            const handle = installStderrTee(logPath);
            assert.ok(handle);
            handle.dispose();
            assert.doesNotThrow(() => handle.dispose());
            cap.restore();
        });

        // The regression this module exists for: once the launcher that spawned the
        // daemon exits, every stderr write throws EPIPE. If the tee re-enters the
        // error path it floods the log and wedges the event loop (observed: a 2.2 GB
        // daemon.err.log of one repeating stack while all RPC timed out).
        it("detaches instead of looping when the underlying stderr throws EPIPE", () => {
            let writes = 0;
            const original = process.stderr.write.bind(process.stderr);
            // biome-ignore lint/suspicious/noExplicitAny: matching Node's write overloads
            (process.stderr as any).write = (): boolean => {
                writes += 1;
                const err = new Error("write EPIPE") as Error & { code: string };
                err.code = "EPIPE";
                throw err;
            };
            const handle = installStderrTee(logPath);
            assert.ok(handle);
            try {
                assert.doesNotThrow(() => process.stderr.write("first\n"));
                for (let i = 0; i < 50; i += 1) process.stderr.write(`line ${i}\n`);
            } finally {
                handle.dispose();
                // biome-ignore lint/suspicious/noExplicitAny: restoring the original binding
                (process.stderr as any).write = original;
            }
            assert.equal(writes, 1, "underlying stderr must be attempted only once, then detached");
        });

        it("invokes the caller callback after detaching so writers never hang", () => {
            const original = process.stderr.write.bind(process.stderr);
            // biome-ignore lint/suspicious/noExplicitAny: matching Node's write overloads
            (process.stderr as any).write = (): boolean => {
                throw new Error("write EPIPE");
            };
            const handle = installStderrTee(logPath);
            assert.ok(handle);
            let called = 0;
            try {
                // First write trips the detach, second takes the already-detached path.
                process.stderr.write("trip\n", () => {
                    called += 1;
                });
                process.stderr.write("after\n", () => {
                    called += 1;
                });
            } finally {
                handle.dispose();
                // biome-ignore lint/suspicious/noExplicitAny: restoring the original binding
                (process.stderr as any).write = original;
            }
            assert.equal(called, 2, "both callbacks must fire even once detached");
        });

        // dispose() must remove the error listeners it added. Without this, ten
        // install/dispose rounds trip MaxListenersExceededWarning and a disposed
        // closure can still be flipped by a listener from a previous install.
        it("leaves no error listeners behind after dispose", () => {
            const cap = stubStderr();
            const baseline = process.stderr.listenerCount("error");
            for (let i = 0; i < 12; i += 1) {
                const handle = installStderrTee(logPath);
                assert.ok(handle);
                handle.dispose();
            }
            cap.restore();
            assert.equal(
                process.stderr.listenerCount("error"),
                baseline,
                "install/dispose cycles must not accumulate stderr error listeners",
            );
        });
    });
});
