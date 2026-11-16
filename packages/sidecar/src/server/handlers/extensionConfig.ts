import { isDeepStrictEqual } from "node:util";
import {
    ErrorCodes,
    type ExtensionConfigResult,
    type ExtensionConfigValue,
    extensionConfigFields,
} from "@taco-ai/protocol";
import { readGlobalConfig, updateGlobalConfig } from "../../config/config.ts";
import { resolveExtensionConfig } from "../../extensions/configuration.ts";
import type { ExtensionRegistry } from "../../extensions/registry.ts";
import { RpcHandlerError, registerMethod } from "../methodRegistry.ts";

function schemaFor(registry: ExtensionRegistry | undefined, name: string): Record<string, unknown> {
    const schema = registry?.configSchema(name);
    if (!schema)
        throw new RpcHandlerError(
            ErrorCodes.InvalidValue,
            "Plugin configuration schema is unavailable",
        );
    return schema;
}
function configFor(
    values: Record<string, unknown> | undefined,
    name: string,
): Record<string, unknown> {
    const value = values && Object.hasOwn(values, name) ? values[name] : undefined;
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}
function view(registry: ExtensionRegistry | undefined, name: string): ExtensionConfigResult {
    const schema = schemaFor(registry, name);
    const current = configFor(readGlobalConfig().extensionConfig, name);
    const values: Record<string, ExtensionConfigValue> = Object.create(null);
    const configuredSecrets: string[] = [];
    for (const field of extensionConfigFields(schema)) {
        if (!Object.hasOwn(current, field.key)) continue;
        const value = current[field.key];
        if (field.secret) {
            if (value !== undefined && value !== "") configuredSecrets.push(field.key);
        } else if (
            typeof value === "string" ||
            typeof value === "boolean" ||
            typeof value === "number"
        )
            values[field.key] = value;
    }
    return {
        schema,
        values,
        configuredSecrets,
        pendingRestart: !isDeepStrictEqual(
            current,
            configFor(registry?.configurationSnapshot().values, name),
        ),
    };
}

export function registerExtensionConfigHandlers(): void {
    registerMethod("extensionConfigGet", false, async ({ server, params }) =>
        view(server.extensionRegistry, params.name),
    );
    registerMethod("extensionConfigUpdate", false, async ({ server, params }) => {
        const schema = schemaFor(server.extensionRegistry, params.name);
        const fields = new Map(extensionConfigFields(schema).map((field) => [field.key, field]));
        for (const key of [...Object.keys(params.values), ...(params.unset ?? [])]) {
            const field = fields.get(key);
            if (!field || field.readOnly)
                throw new RpcHandlerError(ErrorCodes.InvalidValue, `Field is not editable: ${key}`);
        }
        try {
            updateGlobalConfig((current) => {
                const previous = configFor(current.extensionConfig, params.name);
                const next = { ...previous, ...params.values };
                for (const key of params.unset ?? []) delete next[key];
                resolveExtensionConfig(params.name, { [params.name]: next }, schema);
                return { extensionConfig: { ...current.extensionConfig, [params.name]: next } };
            });
        } catch {
            // Validation messages may embed secret values; never echo the raw error.
            throw new RpcHandlerError(
                ErrorCodes.InvalidValue,
                "Plugin configuration could not be saved; check field values and the configuration file",
            );
        }
        return view(server.extensionRegistry, params.name);
    });
}
