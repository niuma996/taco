/**
 * Re-export point for `@earendil-works/pi-agent-core/node`.
 *
 * Separated from `./types.ts` so the bare-package barrel stays a pure
 * `pi-agent-core` re-export, preserving the upstream module's split between
 * runtime harness types and Node-only execution environment types.
 *
 * `NodeExecutionEnv` is a class; `export {}` re-exports both its value
 * (so consumers can `extends` / `new`) and its type (so `import type` and
 * inline `type` markers keep working) without touching the upstream subpath.
 */

export type { FileError, FileInfo, Result } from "@earendil-works/pi-agent-core/node";
export { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
