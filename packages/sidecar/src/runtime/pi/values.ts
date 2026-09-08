/**
 * Re-export point for cross-domain pi value symbols.
 *
 * Mirrors `types.ts` for runtime values: sidecar code that wants a pi value
 * (factory function, leaf helper, tagged error class) imports it from here
 * instead of from `@earendil-works/pi-*` directly. When pi renames or
 * reshapes a value symbol, the churn stays in this one file plus a tsc sweep.
 *
 * Scope: cross-domain symbols only. Single-file consumers, ACL-role files
 * (e.g. `runtime/harnessErrors.ts` owning `LaneBusy`), and the lazy / provider
 * subpaths keep their direct imports — those are intentionally narrow and
 * would only gain a meaningless indirection here.
 */
export { uuidv7 } from "@earendil-works/pi-agent-core";
