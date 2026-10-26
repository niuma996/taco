/**
 * extensions.* handler — extension registry status queries.
 */

import type { ExtensionsStatusResult } from "@taco-ai/protocol";
import { registerMethod } from "../methodRegistry.ts";

export function registerExtensionsHandlers(): void {
    registerMethod("extensionsStatus", false, async ({ server }) => {
        const registry = server.extensionRegistry;
        if (!registry) {
            const empty: ExtensionsStatusResult = {
                loaded: [],
                failed: [],
                unauthorized: [],
                disabled: [],
            };
            return empty;
        }
        const r = registry.report;
        return {
            loaded: r.loaded.map((e) => ({
                name: e.name,
                version: e.version,
                source: e.source,
                permissions: e.permissions,
                description: e.description,
                whenToUse: e.whenToUse,
                tags: e.tags,
            })),
            failed: r.failed,
            unauthorized: r.unauthorized,
            disabled: r.disabled,
        } satisfies ExtensionsStatusResult;
    });
}
