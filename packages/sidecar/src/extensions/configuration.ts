import type { TSchema } from "typebox";
import { Value } from "typebox/value";

export function freezeExtensionConfig<T>(value: T, seen = new WeakSet<object>()): T {
    if (!value || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) freezeExtensionConfig(child, seen);
    return Object.freeze(value);
}

/** Validate a private copy; JSON schema defaults remain descriptive only. */
export function resolveExtensionConfig(
    name: string,
    values: Record<string, unknown>,
    schema?: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
    const value = (Object.hasOwn(values, name) ? values[name] : undefined) ?? {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("invalid extension config: expected object");
    }
    const config = structuredClone(value) as Record<string, unknown>;
    if (schema) {
        let errors: ReturnType<typeof Value.Errors>;
        try {
            errors = [...Value.Errors(schema as TSchema, config)];
        } catch (error) {
            throw new Error(
                `invalid configSchema: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (errors.length > 0) {
            const detail = errors
                .slice(0, 3)
                .map((error) => `${error.instancePath || "/"}: ${error.message}`)
                .join("; ");
            throw new Error(`invalid extension config: ${detail}`);
        }
    }
    return freezeExtensionConfig(config);
}
