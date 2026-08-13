import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImWorkspacePolicy } from "../../src/channels/imWorkspacePolicy.ts";
import { filterToolsForImPolicy } from "../../src/runtime/toolAssembly.ts";
import type { TacoTool } from "../../src/tools/index.ts";

const DEFAULT_POLICY: ImWorkspacePolicy = {
    tools: { fsTools: "deny", shell: "deny" },
    commands: { mode: "ask" },
};

/** Fake tools covering both the fs/process group and unrelated tools. */
function makeTools(withShellExtension: boolean): TacoTool[] {
    const names = [
        "read",
        "write",
        "edit",
        "grep",
        "glob",
        "shell",
        "agent",
        "skill",
        "todo_write",
        "memory",
        "ask_user",
    ];
    const tools = names.map(
        (name): TacoTool => ({ name, execute: async () => ({ text: "" }) }) as unknown as TacoTool,
    );
    if (withShellExtension) {
        // An extension re-registering a same-named shell tool.
        tools.push({
            name: "shell",
            execute: async () => ({ text: "ext" }),
        } as unknown as TacoTool);
    }
    return tools;
}

function names(tools: TacoTool[]): string[] {
    return tools.map((t) => t.name);
}

describe("filterToolsForImPolicy", () => {
    it("default policy removes the six fs/process tools including an extension-supplied shell", () => {
        const out = filterToolsForImPolicy(makeTools(true), DEFAULT_POLICY);
        const n = names(out);
        for (const tool of ["read", "write", "edit", "grep", "glob", "shell"]) {
            assert.ok(!n.includes(tool), `expected ${tool} removed`);
        }
        for (const tool of ["agent", "skill", "todo_write", "memory", "ask_user"]) {
            assert.ok(n.includes(tool), `expected ${tool} kept`);
        }
    });

    it("shell allow keeps shell but still removes the five fs tools", () => {
        const policy: ImWorkspacePolicy = {
            tools: { fsTools: "deny", shell: "allow" },
            commands: { mode: "ask" },
        };
        const out = filterToolsForImPolicy(makeTools(true), policy);
        const n = names(out);
        assert.ok(n.includes("shell"));
        for (const tool of ["read", "write", "edit", "grep", "glob"]) {
            assert.ok(!n.includes(tool), `expected ${tool} removed`);
        }
    });

    it("fsTools allow keeps the five fs tools but still removes shell", () => {
        const policy: ImWorkspacePolicy = {
            tools: { fsTools: "allow", shell: "deny" },
            commands: { mode: "ask" },
        };
        const out = filterToolsForImPolicy(makeTools(false), policy);
        const n = names(out);
        for (const tool of ["read", "write", "edit", "grep", "glob"]) {
            assert.ok(n.includes(tool), `expected ${tool} kept`);
        }
        assert.ok(!n.includes("shell"), "expected shell removed");
    });

    it("both allow keeps everything", () => {
        const policy: ImWorkspacePolicy = {
            tools: { fsTools: "allow", shell: "allow" },
            commands: { mode: "ask" },
        };
        const out = filterToolsForImPolicy(makeTools(false), policy);
        assert.equal(out.length, makeTools(false).length);
    });

    it("does not mutate the input array when nothing is dropped", () => {
        const input = makeTools(false);
        const policy: ImWorkspacePolicy = {
            tools: { fsTools: "allow", shell: "allow" },
            commands: { mode: "ask" },
        };
        const out = filterToolsForImPolicy(input, policy);
        assert.equal(out, input); // same reference — no copy when nothing dropped
    });
});

// Kept import as a type-only reference so the AgentTool type is exercised
// without pulling an unused import into the assertion helpers above.
export type _Unused = AgentTool;
