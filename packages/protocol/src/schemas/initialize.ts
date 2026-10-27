/**
 * initialize RPC param schema — intentionally permissive to support older
 * clients mid-rollout. `Type.Unknown()` accepts ANY value, so this schema
 * deliberately performs no validation; the real check lives in the handler,
 * which rejects a missing or non-numeric `protocolVersion.{major,minor}`
 * with `invalid_params` and an incompatible version with
 * `incompatible_protocol`. Keeping the gate here open (rather than
 * tightening it alongside the other schemas) is the point: a client that
 * sends a partial capability payload must still reach the handler's
 * version-negotiation path instead of being rejected at the envelope.
 */
import { Type } from "typebox";
import type { InitializeParams } from "../frames.js";

/**
 * The schema stays `Type.Unknown()` — the gate is deliberately open — but the
 * static type is pinned to `InitializeParams` so the contract table still
 * declares what a well-formed `initialize` carries. `Type.Unsafe` changes
 * only the static side: at runtime the schema still accepts anything, which
 * is the point of keeping the gate open.
 */
export const initializeSchema = Type.Unsafe<InitializeParams>(Type.Unknown());
