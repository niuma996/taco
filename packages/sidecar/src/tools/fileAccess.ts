/**
 * Which built-in tools touch the filesystem, and through which arguments.
 *
 * The single source for the mutation gate's write/read fences, the IM
 * file-tool deny list, the deferred-tool catalog filter and the deferred
 * load-time deny gate. A built-in tool that reads or writes files and is
 * missing here fails open: its write target skips containment and an IM
 * session can reach it. The consistency test in
 * `tests/tools/fileAccess.test.ts` checks every built-in against this table.
 *
 * Keyed by name and kept free of imports, so the gate and the deferred
 * catalog can consult it without loading a tool's implementation.
 */

export interface PathArg {
    /** Top-level input key holding the path. */
    readonly key: string;
    /** The value is an array of paths rather than a single one. */
    readonly many?: boolean;
}

export interface FileAccess {
    /** Optional path arguments the tool reads; an absent one means the cwd. */
    readonly reads?: readonly PathArg[];
    /** Required string argument naming the write target (a file, or for pdfSplit a directory). */
    readonly write?: string;
}

const BUILTIN_FILE_ACCESS: Readonly<Record<string, FileAccess>> = {
    read: { reads: [{ key: "path" }] },
    grep: { reads: [{ key: "path" }] },
    glob: { reads: [{ key: "path" }] },
    write: { write: "path" },
    edit: { write: "path" },
    pdfMerge: { reads: [{ key: "inputs", many: true }], write: "output" },
    pdfSplit: { reads: [{ key: "input" }], write: "outputDir" },
    pdfFill: { reads: [{ key: "input" }], write: "output" },
    pdfFields: { reads: [{ key: "input" }] },
};

/** Names of the built-in tools that read or write files. */
export const FILE_ACCESS_TOOL_NAMES: readonly string[] = Object.keys(BUILTIN_FILE_ACCESS);

export function fileAccessOf(toolName: string): FileAccess | undefined {
    return Object.hasOwn(BUILTIN_FILE_ACCESS, toolName) ? BUILTIN_FILE_ACCESS[toolName] : undefined;
}

/**
 * Whether a tool name is a built-in file tool the session's policy denies.
 * The same table that feeds the mutation gate and the resident-set IM
 * filter decides here, so the deferred catalog, `restoreTools`, `addTools`
 * and the attach-time allowlist prune all agree on what "denied" means. A
 * name outside the table (an MCP or extension tool) is never denied by this
 * judgment, and anything but a deny verdict denies nothing.
 */
export function isFsToolDenied(toolName: string, fsToolsDenied: boolean | undefined): boolean {
    return fsToolsDenied === true && fileAccessOf(toolName) !== undefined;
}

/**
 * Paths a call reads, per the table. Undefined when the tool takes no read
 * path; empty when it does but this call named none.
 */
export function readPathsOf(
    toolName: string,
    input: Record<string, unknown>,
): readonly string[] | undefined {
    const reads = fileAccessOf(toolName)?.reads;
    if (!reads) return undefined;
    const paths: string[] = [];
    for (const arg of reads) {
        const raw = input[arg.key];
        const values = arg.many ? (Array.isArray(raw) ? raw : []) : [raw];
        for (const value of values) {
            if (typeof value === "string" && value.trim() !== "") paths.push(value);
        }
    }
    return paths;
}
