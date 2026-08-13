/**
 * Builtin extension manifest list.
 *
 * This is the single place that enumerates which first-party extensions ship
 * with sidecar. The generic dispatcher in `registerBuiltinExtensions` receives
 * this list and knows nothing about individual builtins.
 */

import type { BuiltinManifest } from "../builtinContract.ts";
import { manifest as gitContextManifest } from "./gitContext/index.ts";
import { manifest as outputRedactionManifest } from "./outputRedaction/index.ts";
import { manifest as projectManifestsManifest } from "./projectManifests/index.ts";

export const BUILTIN_EXTENSIONS: readonly BuiltinManifest[] = [
    outputRedactionManifest,
    gitContextManifest,
    projectManifestsManifest,
];
