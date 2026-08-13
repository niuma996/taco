/**
 * Test-only tag definitions shared by tag-policy unit tests.
 *
 * Kept OUT of the production tag registry (tags/registry.ts) because the
 * `validateBuiltinRegistry()` self-check asserts the registry contains only
 * real production tags. Tests that need a drop / ephemeral tag should import
 * from here instead of registering a fixture at module scope.
 */

import { defineTag } from "../../src/tags/builder.ts";
import type { TagSpec } from "../../src/tags/types.ts";

export const TEST_DROP_TAG: TagSpec = defineTag({
    name: "__test_drop__",
    scope: "system",
    compression: { kind: "drop" },
    tuiVisibility: "hidden",
    parser: { kind: "xml-balanced" },
    description: "Test-only drop tag for drop policy tests.",
});

export const TEST_EPHEMERAL_TAG: TagSpec = defineTag({
    name: "__test_ephemeral__",
    scope: "user-request",
    compression: { kind: "pin" },
    tuiVisibility: "ephemeral",
    parser: { kind: "xml-balanced" },
    description: "Test-only ephemeral tag for visibility policy tests.",
});
