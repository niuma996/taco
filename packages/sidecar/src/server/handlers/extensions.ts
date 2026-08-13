/**
 * extensions.* handler — extension registry status queries.
 */

import type { ExtensionsStatusParams, ExtensionsStatusResult } from "@taco-ai/protocol";
import { extensionsStatusSchema } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { type MethodCtx, registerMethod } from "../methodRegistry.ts";

export function registerExtensionsHandlers(): void {
    registerMethod(
        RPC.extensionsStatus,
        false,
        async ({ server }: MethodCtx<ExtensionsStatusParams>) => {
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
        },
        { schema: extensionsStatusSchema },
    );
}
