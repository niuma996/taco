/**
 * extensions.* handler — extension registry status queries.
 */

import { isDeepStrictEqual } from "node:util";
import type { ExtensionsStatusResult, TacoGlobalConfigShape } from "@taco-ai/protocol";
import { readGlobalConfig } from "../../config/config.ts";
import type { ExtensionRegistry } from "../../extensions/registry.ts";
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
                disabledEntries: [],
                pendingRestart: {
                    loadedButDisabled: [],
                    disabledButEnabled: [],
                    failed: [],
                    configuration: [],
                },
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
                configSchema: e.configSchema,
                contributions: e.contributions,
            })),
            failed: r.failed,
            unauthorized: r.unauthorized,
            disabled: r.disabled,
            disabledEntries: r.disabledEntries,
            pendingRestart: pendingRestart(registry),
        } satisfies ExtensionsStatusResult;
    });
}

function pendingRestart(registry: ExtensionRegistry): ExtensionsStatusResult["pendingRestart"] {
    let current: TacoGlobalConfigShape;
    try {
        current = readGlobalConfig();
    } catch {
        // Runtime diagnostics remain useful even when taco.json cannot be parsed.
        return { loadedButDisabled: [], disabledButEnabled: [], failed: [], configuration: [] };
    }
    const currentDisabled = new Set(current.disabledExtensions ?? []);
    const currentExtensions = new Set(current.extensions ?? []);
    const currentConfig = current.extensionConfig ?? {};
    const actual = registry.configurationSnapshot();
    const report = registry.report;
    const loadedButDisabled = report.loaded
        .filter((entry) => currentDisabled.has(entry.name))
        .map((entry) => entry.name);
    const disabledButEnabled = report.disabled.filter((name) => !currentDisabled.has(name));
    const names = new Set<string>([
        ...actual.disabled,
        ...currentDisabled,
        ...actual.extensions,
        ...currentExtensions,
        ...Object.keys(actual.values),
        ...Object.keys(currentConfig),
    ]);
    const valueFor = (values: Record<string, unknown>, name: string): unknown =>
        Object.hasOwn(values, name) ? (values[name] ?? {}) : {};
    const configuration = [...names].filter(
        (name) =>
            actual.disabled.has(name) !== currentDisabled.has(name) ||
            actual.extensions.has(name) !== currentExtensions.has(name) ||
            !isDeepStrictEqual(valueFor(actual.values, name), valueFor(currentConfig, name)),
    );
    const changed = new Set(configuration);
    const failed = [
        ...new Set(
            report.failed
                .filter(
                    (entry) =>
                        (entry.stage ?? "load") === "load" &&
                        !currentDisabled.has(entry.name) &&
                        changed.has(entry.name),
                )
                .map((entry) => entry.name),
        ),
    ];
    return { loadedButDisabled, disabledButEnabled, failed, configuration };
}
