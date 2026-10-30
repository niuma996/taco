import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CommandPermissionConfig, CommandPermissionRequest } from "@taco-ai/protocol";
import { evaluateCommand } from "../../src/permissions/commandPolicy.ts";
import { PermissionBroker } from "../../src/permissions/permissionBroker.ts";
import {
    normalizeBuiltinToolPath,
    resolveWithinRoot,
    resolveWithinRootSet,
} from "../../src/permissions/workspaceBoundary.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { createWriteTool } from "../../src/runtime/pi/values.ts";

describe("permissionBroker", () => {
    describe("PermissionBroker readOnly mode", () => {
        it("readOnly: isStrictReadOnly command auto-allows", async () => {
            const broker = new PermissionBroker(
                () => ({
                    mode: "auto",
                    rules: ["rm -rf /"], // would leak without readOnly
                }),
                { readOnly: true },
            );
            const result = await broker.evaluateAndRequest({
                sessionId: "fake-session",
                toolCallId: "fake",
                command: "ls",
            });
            // "ls" is isStrictReadOnly → auto-allow in auto mode
            assert.equal(result.approved, true);
        });

        it("readOnly: mutating command denies immediately (no ask/hang)", async () => {
            const broker = new PermissionBroker(
                () => ({
                    mode: "auto",
                    rules: ["rm -rf /"], // must be ignored in readOnly
                }),
                { readOnly: true },
            );
            // A user allowlist rule that would normally grant this must NOT apply
            const result = await broker.evaluateAndRequest({
                sessionId: "fake-session",
                toolCallId: "fake",
                command: "rm -rf /",
            });
            assert.equal(result.approved, false);
            assert.equal(result.denialReason, undefined); // immediate deny, not user_denied/timeout
        });

        it("readOnly: user session rules do not leak into evaluation", async () => {
            const broker = new PermissionBroker(() => ({ mode: "auto", rules: [] }), {
                readOnly: true,
            });
            // Inject a session rule that would allow a mutating command — must be ignored
            (broker as unknown as { sessionRules: Map<string, string[]> }).sessionRules.set(
                "fake-session",
                ["touch /tmp/x"],
            );
            const result = await broker.evaluateAndRequest({
                sessionId: "fake-session",
                toolCallId: "fake",
                command: "touch /tmp/x",
            });
            assert.equal(result.approved, false);
        });
    });
});

describe("permissionBroker.config", () => {
    const noRules = { mode: "ask" } as const;

    describe("PermissionBroker config approval", () => {
        it("asks, and reports the fields being changed", async () => {
            const broker = new PermissionBroker(() => noRules);
            const requested: CommandPermissionRequest[] = [];
            broker.on("requested", (r: CommandPermissionRequest) => requested.push(r));

            const pending = broker.requestConfigApproval({
                sessionId: "s1",
                toolCallId: "tc1",
                fields: ["defaultModel", "thinkingLevel"],
            });
            await Promise.resolve();

            assert.equal(requested.length, 1);
            assert.equal(requested[0].kind, "config");
            assert.deepEqual(requested[0].configFields, ["defaultModel", "thinkingLevel"]);
            // The command slot carries a readable stand-in — there is no command.
            assert.match(requested[0].command, /defaultModel/);

            broker.resolve(requested[0].requestId, true, "once");
            const decision = await pending;
            assert.equal(decision.approved, true);
        });

        it("is never persistable: a session or global scope falls back to once", async () => {
            const broker = new PermissionBroker(() => noRules);
            const requested: CommandPermissionRequest[] = [];
            broker.on("requested", (r: CommandPermissionRequest) => requested.push(r));

            const pending = broker.requestConfigApproval({
                sessionId: "s1",
                toolCallId: "tc1",
                fields: ["defaultModel"],
            });
            await Promise.resolve();

            broker.resolve(requested[0].requestId, true, "global");
            const decision = await pending;
            assert.equal(decision.scope, "once");
        });

        it("denies at once when no approver can answer", async () => {
            const broker = new PermissionBroker(() => noRules, { hasApprover: () => false });
            const decision = await broker.requestConfigApproval({
                sessionId: "s1",
                toolCallId: "tc1",
                fields: ["defaultModel"],
            });
            assert.equal(decision.approved, false);
            assert.equal(decision.denialReason, "no_approver");
        });

        it("a declined change writes nothing", async () => {
            const broker = new PermissionBroker(() => noRules);
            const requested: CommandPermissionRequest[] = [];
            broker.on("requested", (r: CommandPermissionRequest) => requested.push(r));

            const pending = broker.requestConfigApproval({
                sessionId: "s1",
                toolCallId: "tc1",
                fields: ["commandPermissions"],
            });
            await Promise.resolve();
            broker.resolve(requested[0].requestId, false, "once");

            const decision = await pending;
            assert.equal(decision.approved, false);
            assert.equal(decision.denialReason, "user_denied");
        });
    });
});

describe("permissionBrokerImPolicy", () => {
    const GLOBAL: CommandPermissionConfig = { mode: "ask", allow: [], deny: [] };

    describe("PermissionBroker IM policy", () => {
        it("without an IM policy, behaviour is byte-identical to today", async () => {
            const broker = new PermissionBroker(() => GLOBAL, { requestTimeoutMs: 50 });
            let requested = 0;
            broker.on("requested", () => requested++);
            const decision = await broker.evaluateAndRequest({
                sessionId: "s1",
                toolCallId: "t1",
                command: "ls",
            });
            assert.equal(decision.approved, false);
            assert.equal(requested, 1); // ask path still opens a request
        });

        it("auto channel approves a non-denylisted command without emitting a request", async () => {
            const broker = new PermissionBroker(() => GLOBAL, {
                imCommandPolicy: () => ({ mode: "auto" }),
            });
            let requested = 0;
            broker.on("requested", () => requested++);
            const decision = await broker.evaluateAndRequest({
                sessionId: "s1",
                toolCallId: "t1",
                command: "pnpm build",
            });
            assert.equal(decision.approved, true);
            assert.equal(requested, 0);
        });

        it("auto channel still asks for a channel-denylisted command", async () => {
            const broker = new PermissionBroker(() => GLOBAL, {
                imCommandPolicy: () => ({ mode: "auto", deny: ["cat *"] }),
                requestTimeoutMs: 50,
            });
            let requested = 0;
            broker.on("requested", () => requested++);
            const decision = await broker.evaluateAndRequest({
                sessionId: "s1",
                toolCallId: "t1",
                command: "cat f",
            });
            assert.equal(decision.approved, false);
            assert.equal(requested, 1);
            assert.equal(decision.evaluation.matchedList, "deny");
        });

        it("session-scoped approvals still apply on the ask path", async () => {
            const broker = new PermissionBroker(() => GLOBAL);
            const requestId = new Promise<string>((resolve) => {
                broker.once("requested", (value) => resolve(value.requestId));
            });
            const pending = broker.evaluateAndRequest({
                sessionId: "s1",
                toolCallId: "t1",
                command: "pnpm test",
            });
            broker.resolve(await requestId, true, "session");
            assert.equal((await pending).approved, true);

            const next = await broker.evaluateAndRequest({
                sessionId: "s1",
                toolCallId: "t2",
                command: "pnpm test",
            });
            assert.equal(next.approved, true);
        });
    });

    describe("PermissionBroker without an approver", () => {
        it("denies an ask at once instead of waiting for the timeout", async () => {
            const broker = new PermissionBroker(() => GLOBAL, {
                imCommandPolicy: () => ({ mode: "ask" }),
                hasApprover: () => false,
                requestTimeoutMs: 60_000,
            });
            let requested = 0;
            broker.on("requested", () => requested++);
            const decision = await broker.evaluateAndRequest({
                sessionId: "s1",
                toolCallId: "t1",
                command: "pnpm build",
            });
            assert.equal(decision.approved, false);
            assert.equal(decision.denialReason, "no_approver");
            assert.equal(requested, 0);
        });

        it("still allows commands that need no approval", async () => {
            const broker = new PermissionBroker(() => GLOBAL, {
                imCommandPolicy: () => ({ mode: "ask", allow: ["pnpm build"] }),
                hasApprover: () => false,
            });
            const decision = await broker.evaluateAndRequest({
                sessionId: "s1",
                toolCallId: "t1",
                command: "pnpm build",
            });
            assert.equal(decision.approved, true);
        });

        describe("PermissionBroker in an IM conversation", () => {
            // The person on the channel has no approval UI and the desktop user is
            // usually not watching, so an ask would only stall the chat until the
            // ten-minute timeout. It is refused at once, even with a desktop
            // connected, and the reason tells the model it was automatic.
            it("refuses an ask at once even when a desktop could answer", async () => {
                const broker = new PermissionBroker(() => GLOBAL, {
                    imCommandPolicy: () => ({ mode: "ask" }),
                    hasApprover: () => true,
                    refuseApprovals: true,
                    requestTimeoutMs: 60_000,
                });
                let requested = 0;
                broker.on("requested", () => requested++);
                const decision = await broker.evaluateAndRequest({
                    sessionId: "s1",
                    toolCallId: "t1",
                    command: "pnpm build",
                });
                assert.equal(decision.approved, false);
                assert.equal(decision.denialReason, "im_channel");
                assert.equal(requested, 0, "no prompt reaches the desktop");
            });

            it("refuses a config change the same way", async () => {
                const broker = new PermissionBroker(() => GLOBAL, { refuseApprovals: true });
                const decision = await broker.requestConfigApproval({
                    sessionId: "s1",
                    toolCallId: "t1",
                    fields: ["defaultModel"],
                });
                assert.equal(decision.approved, false);
                assert.equal(decision.denialReason, "im_channel");
            });

            it("still runs commands the policy allows", async () => {
                const broker = new PermissionBroker(() => GLOBAL, {
                    imCommandPolicy: () => ({ mode: "ask", allow: ["pnpm build"] }),
                    refuseApprovals: true,
                });
                const decision = await broker.evaluateAndRequest({
                    sessionId: "s1",
                    toolCallId: "t1",
                    command: "pnpm build",
                });
                assert.equal(decision.approved, true);
            });
        });
    });
});

describe("workspaceBoundary", () => {
    describe("resolveWithinRoot", () => {
        let root: string;
        let outside: string;

        beforeEach(() => {
            const base = mkdtempSync(join(tmpdir(), "taco-boundary-"));
            root = join(base, "workspace");
            outside = join(base, "outside");
            mkdirSync(root, { recursive: true });
            mkdirSync(outside, { recursive: true });
        });

        afterEach(() => {
            rmSync(root, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        });

        it("allows a relative path inside the root", async () => {
            const result = await resolveWithinRoot(root, "src/index.ts");
            assert.equal(result.ok, true);
            if (result.ok) assert.equal(result.absolutePath, join(root, "src/index.ts"));
        });

        it("allows a not-yet-created nested path", async () => {
            const result = await resolveWithinRoot(root, "a/b/c/new.ts");
            assert.equal(result.ok, true);
        });

        it("rejects traversal above the root", async () => {
            const result = await resolveWithinRoot(root, "../outside/x.ts");
            assert.equal(result.ok, false);
            if (!result.ok) assert.match(result.reason, /outside the workspace root/);
        });

        it("rejects an absolute path outside the root", async () => {
            const result = await resolveWithinRoot(root, join(outside, "x.ts"));
            assert.equal(result.ok, false);
        });

        it("rejects an empty path", async () => {
            const result = await resolveWithinRoot(root, "   ");
            assert.equal(result.ok, false);
            if (!result.ok) assert.match(result.reason, /must not be empty/);
        });

        // Lexical checks pass here — only realpath resolution catches it.
        it("rejects a write through a symlinked directory pointing outside", async () => {
            symlinkSync(outside, join(root, "escape"), "dir");
            const result = await resolveWithinRoot(root, "escape/x.ts");
            assert.equal(result.ok, false);
            if (!result.ok) assert.match(result.reason, /outside the workspace root/);
        });

        it("rejects an existing symlinked file pointing outside", async () => {
            const target = join(outside, "secret.txt");
            writeFileSync(target, "s");
            symlinkSync(target, join(root, "link.txt"));
            const result = await resolveWithinRoot(root, "link.txt");
            assert.equal(result.ok, false);
        });

        it("treats the root itself as contained", async () => {
            const result = await resolveWithinRoot(root, ".");
            assert.equal(result.ok, true);
        });

        // Regression: a root that is itself a symlink must still compare against
        // its resolved target, not the symlink path. Otherwise a workspace whose
        // real location differs from the input string leaks containment.
        it("resolves a symlinked root before containment", async () => {
            const realRoot = join(root, "..", "real-workspace");
            mkdirSync(realRoot, { recursive: true });
            writeFileSync(join(realRoot, "inside.txt"), "ok");
            const linkedRoot = join(root, "link");
            symlinkSync(realRoot, linkedRoot);

            const result = await resolveWithinRoot(linkedRoot, "inside.txt");
            assert.equal(result.ok, true);
            // `absolutePath` stays lexical — containment is what compares to the
            // realpath of the symlinked root.
            if (result.ok) assert.equal(result.absolutePath, join(linkedRoot, "inside.txt"));
        });

        it("rejects a path that escapes through a symlinked root", async () => {
            const realRoot = join(root, "..", "real-workspace");
            mkdirSync(realRoot, { recursive: true });
            const linkedRoot = join(root, "link");
            symlinkSync(realRoot, linkedRoot);

            // The real target sits next to realRoot, not inside it.
            const sibling = join(realRoot, "..", "outside.txt");
            writeFileSync(sibling, "nope");
            const result = await resolveWithinRoot(linkedRoot, join("..", "outside.txt"));
            assert.equal(result.ok, false);
        });
    });

    describe("resolveWithinRootSet", () => {
        let root: string;
        let associated: string;
        let outside: string;

        beforeEach(() => {
            const base = mkdtempSync(join(tmpdir(), "taco-rootset-"));
            root = join(base, "workspace");
            associated = join(base, "associated");
            outside = join(base, "outside");
            mkdirSync(root, { recursive: true });
            mkdirSync(associated, { recursive: true });
            mkdirSync(outside, { recursive: true });
        });

        afterEach(() => {
            rmSync(root, { recursive: true, force: true });
            rmSync(associated, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        });

        it("allows a path inside the primary root", async () => {
            const result = await resolveWithinRootSet(root, [associated], "src/index.ts");
            assert.equal(result.ok, true);
        });

        it("allows an absolute path inside an associated root", async () => {
            const result = await resolveWithinRootSet(root, [associated], join(associated, "a.ts"));
            assert.equal(result.ok, true);
            if (result.ok) assert.equal(result.absolutePath, join(associated, "a.ts"));
        });

        it("rejects a path that is in neither root", async () => {
            const result = await resolveWithinRootSet(root, [associated], join(outside, "a.ts"));
            assert.equal(result.ok, false);
            if (!result.ok) assert.match(result.reason, /associated directories/);
        });

        it("does not re-anchor a relative path onto an associated root", async () => {
            // "notes.md" means the workspace's own notes.md. It must not resolve
            // to associated/notes.md just because the directory is associated.
            const result = await resolveWithinRootSet(root, [associated], "notes.md");
            assert.equal(result.ok, true);
            if (result.ok) assert.equal(result.absolutePath, join(root, "notes.md"));
        });

        it("allows a relative traversal that lands inside an associated root", async () => {
            // The path still resolves against the primary root; the associated
            // root only decides whether the result is permitted.
            const result = await resolveWithinRootSet(root, [associated], "../associated/a.ts");
            assert.equal(result.ok, true);
            if (result.ok) assert.equal(result.absolutePath, join(associated, "a.ts"));
        });

        it("rejects a path that escapes an associated root through a symlink", async () => {
            symlinkSync(outside, join(associated, "escape"), "dir");
            const result = await resolveWithinRootSet(
                root,
                [associated],
                join(associated, "escape", "a.ts"),
            );
            assert.equal(result.ok, false);
        });

        it("rejects an empty path", async () => {
            const result = await resolveWithinRootSet(root, [associated], "  ");
            assert.equal(result.ok, false);
            if (!result.ok) assert.match(result.reason, /must not be empty/);
        });

        it("keeps the plain reason when no associated root is given", async () => {
            const result = await resolveWithinRootSet(root, [], join(outside, "a.ts"));
            assert.equal(result.ok, false);
            if (!result.ok) assert.doesNotMatch(result.reason, /associated directories/);
        });
    });

    // The gate checks the path pi's built-in write/edit will actually touch, so its
    // normalisation must not drift from pi's. Drive pi's real `write` tool with an
    // env whose path resolution is pi's own (NodeExecutionEnv) but whose writeFile
    // only records the target — a pi upgrade that changes the rules fails here.
    describe("normalizeBuiltinToolPath matches pi's write tool", () => {
        const cwd = mkdtempSync(join(tmpdir(), "taco-parity-"));
        const real = new NodeExecutionEnv({ cwd });

        async function piWriteTarget(rawPath: string): Promise<string> {
            let target = "";
            const env = new Proxy(real, {
                get(obj, key, receiver) {
                    if (key === "writeFile") {
                        return async (path: string) => {
                            target = path;
                            return { ok: true, value: undefined };
                        };
                    }
                    const value = Reflect.get(obj, key, receiver);
                    return typeof value === "function" ? value.bind(obj) : value;
                },
            });
            const tool = createWriteTool();
            await tool.execute(
                "t",
                { path: rawPath, content: "" },
                () => undefined,
                { env } as never,
                undefined as never,
                { abortSignal: undefined } as never,
            );
            return target;
        }

        for (const raw of [
            "src/a.ts",
            "../escape.ts",
            "/etc/hosts",
            "~",
            "~/.taco/taco.json",
            "@src/a.ts",
            "@/etc/hosts",
            "@~/x.ts",
            "file:///etc/hosts",
            "file://%zz",
            "with\u00A0nbsp.ts",
        ]) {
            it(`agrees on ${JSON.stringify(raw)}`, async () => {
                assert.equal(resolve(cwd, normalizeBuiltinToolPath(raw)), await piWriteTarget(raw));
            });
        }
    });
});

describe("commandApproval.integration", () => {
    const manual = { mode: "ask" as const, allow: [], deny: [] };
    describe("combined shell approval policy", () => {
        it("uses the deny-first decision table for every risk", () => {
            for (const command of ["git diff", "pnpm build", "git checkout main"]) {
                assert.equal(
                    evaluateCommand(command, { ...manual, mode: "auto" }).behavior,
                    "allow",
                    command,
                );
                const denied = evaluateCommand(command, {
                    ...manual,
                    mode: "auto",
                    allow: ["*"],
                    deny: [command],
                });
                assert.equal(denied.behavior, "ask", command);
                assert.equal(denied.matchedList, "deny", command);
                assert.equal(
                    evaluateCommand(command, { ...manual, allow: [command] }).behavior,
                    "allow",
                    command,
                );
            }
            // Built-in denylist: neither auto mode nor an allow rule passes these.
            for (const command of ["git push origin main", "rm -rf build"]) {
                for (const config of [
                    { ...manual, mode: "auto" as const },
                    { ...manual, allow: [command] },
                    { ...manual, mode: "auto" as const, allow: ["*"] },
                ]) {
                    const result = evaluateCommand(command, config);
                    assert.equal(result.behavior, "ask", command);
                    assert.equal(result.matchedList, "deny", command);
                }
            }
            assert.equal(evaluateCommand("git diff", manual).behavior, "allow");
            assert.equal(evaluateCommand("pnpm build", manual).behavior, "ask");
        });
        it("checks every command including quoted commands and directory changes", () => {
            const config = { ...manual, mode: "auto" as const, deny: ["git diff", "cd *"] };
            for (const command of [
                'git status && "git" "diff"',
                "cd . && git status",
                "git status | git diff",
            ]) {
                const result = evaluateCommand(command, config, { cwd: process.cwd() });
                assert.equal(result.behavior, "ask", command);
                assert.equal(result.matchedList, "deny", command);
            }
        });
        it("does not hide later privilege denials behind earlier approval", () => {
            for (const command of [
                "pnpm build && sudo ls",
                "echo $(pwd); sudo ls",
                "git diff > out; sudo ls",
            ]) {
                assert.equal(evaluateCommand(command, manual).behavior, "deny", command);
            }
        });
        it("tracks relative cd chains and rejects symlink escapes", () => {
            const base = mkdtempSync(join(tmpdir(), "taco-approval-"));
            const root = join(base, "root");
            const outside = join(base, "outside");
            mkdirSync(join(root, "a", "b"), { recursive: true });
            mkdirSync(outside);
            symlinkSync(outside, join(root, "escape"), "dir");
            try {
                const context = { cwd: root };
                assert.equal(
                    evaluateCommand("cd a && cd b && git diff", manual, context).behavior,
                    "allow",
                );
                assert.equal(
                    evaluateCommand("cd a && cd ../.. && git diff", manual, context).behavior,
                    "ask",
                );
                assert.equal(
                    evaluateCommand("cd escape && git diff", manual, context).behavior,
                    "ask",
                );
                assert.equal(
                    evaluateCommand(`cd "${outside}" && git diff`, manual, {
                        ...context,
                        allowedRoots: [outside],
                    }).behavior,
                    "allow",
                );
                assert.equal(evaluateCommand("cd .; git diff", manual, context).behavior, "allow");
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });
        it("keeps unknown syntax subject to approval", () => {
            for (const command of ["echo $(pwd)", "git diff &&", "if true; then git diff; fi"]) {
                assert.equal(
                    evaluateCommand(command, { ...manual, mode: "auto" }).behavior,
                    "ask",
                    command,
                );
            }
        });
        it("isolates readonly execution from global automatic mode", async () => {
            const broker = new PermissionBroker(() => ({ mode: "auto", allow: ["*"], deny: [] }), {
                readOnly: true,
            });
            for (const command of [
                "touch output",
                "git checkout main",
                "find . -delete",
                "git diff > out",
            ]) {
                const decision = await broker.evaluateAndRequest({
                    sessionId: "s",
                    toolCallId: "t",
                    command,
                });
                assert.equal(decision.approved, false, command);
                assert.equal(decision.evaluation.behavior, "deny", command);
            }
        });
        it("restricts blacklist approvals to once despite forged session scope", async () => {
            const broker = new PermissionBroker(
                () => ({ ...manual, mode: "auto", deny: ["pnpm *"] }),
                {
                    requestTimeoutMs: 100,
                },
            );
            broker.on("requested", (request) => broker.resolve(request.requestId, true, "session"));
            const result = await broker.evaluateAndRequest({
                sessionId: "s",
                toolCallId: "t",
                command: "pnpm build",
            });
            assert.equal(result.approved, true);
            assert.equal(result.scope, "once");
        });
    });
});
