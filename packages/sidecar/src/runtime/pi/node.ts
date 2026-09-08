/**
 * Types from `@earendil-works/pi-agent-core/node`.
 *
 * Separated from `./types.ts` so the bare-package barrel stays a pure
 * `pi-agent-core` re-export, preserving the upstream module's split between
 * runtime harness types and Node-only execution environment types.
 */
export type { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
