/**
 * Node → Rust target-triple mapping. Only supports the current sidecar target set:
 *   darwin+arm64 → aarch64-apple-darwin
 *   darwin+x64   → x86_64-apple-darwin
 *   linux+x64    → x86_64-unknown-linux-gnu
 *   linux+arm64  → aarch64-unknown-linux-gnu
 *   win32+x64    → x86_64-pc-windows-msvc
 *   win32+arm64  → aarch64-pc-windows-msvc
 */

import process from "node:process";

const FROM_PROCESS = {
    "darwin:arm64": "aarch64-apple-darwin",
    "darwin:x64": "x86_64-apple-darwin",
    "linux:x64": "x86_64-unknown-linux-gnu",
    "linux:arm64": "aarch64-unknown-linux-gnu",
    "win32:x64": "x86_64-pc-windows-msvc",
    "win32:arm64": "aarch64-pc-windows-msvc",
};

const TRIPLES = Object.values(FROM_PROCESS);

export function currentTriple() {
    const key = `${process.platform}:${process.arch}`;
    const triple = FROM_PROCESS[key];
    if (!triple) {
        throw new Error(
            `unsupported host platform: ${key}; only ${Object.keys(FROM_PROCESS).join(", ")} are recognized`,
        );
    }
    return triple;
}

export function parseTargetCli(argv) {
    const idx = argv.indexOf("--target");
    if (idx === -1) return null;
    const triple = argv[idx + 1];
    if (!triple || triple.startsWith("--")) {
        throw new Error("--target requires a triple value (e.g. aarch64-apple-darwin)");
    }
    if (!TRIPLES.includes(triple)) {
        throw new Error(
            `unsupported target triple: ${triple}; expected one of ${TRIPLES.join(", ")}`,
        );
    }
    return triple;
}

/**
 * 校验显式 triple 与当前 process 平台一致 — CI 在 runner 上启动 `package:runtime`
 * 时,显式 triple 必须匹配;不匹配说明脚本被错平台调用,应早失败而非产出
 * 跨平台错的二进制。
 */
export function assertTripleMatchesHost(triple) {
    const host = currentTriple();
    if (triple !== host) {
        throw new Error(
            `target ${triple} does not match host ${host}; cross-build requires explicit per-arch environment, not implemented yet`,
        );
    }
}
