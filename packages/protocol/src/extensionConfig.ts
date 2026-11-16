/** Schema subset editable by the plugin settings UI; other JSON schema shapes remain file-only. */
export type ExtensionConfigValue = string | number | boolean;
export interface ExtensionConfigField {
    key: string;
    type: "string" | "number" | "integer" | "boolean";
    schema: Record<string, unknown>;
    secret: boolean;
    readOnly: boolean;
    required: boolean;
}

export function extensionConfigFields(schema?: Record<string, unknown>): ExtensionConfigField[] {
    if (
        schema?.type !== "object" ||
        !schema.properties ||
        typeof schema.properties !== "object" ||
        Array.isArray(schema.properties)
    )
        return [];
    // Conditional/composed root schemas cannot be safely represented by independent controls.
    if (["allOf", "anyOf", "oneOf", "if", "$ref"].some((key) => Object.hasOwn(schema, key)))
        return [];
    return Object.entries(schema.properties).flatMap(([key, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const field = value as Record<string, unknown>;
        const type = field.type;
        if (type !== "string" && type !== "boolean" && type !== "integer" && type !== "number")
            return [];
        if (
            ["allOf", "anyOf", "oneOf", "if", "$ref", "const"].some((key) =>
                Object.hasOwn(field, key),
            )
        )
            return [];
        if (
            field.enum !== undefined &&
            (!Array.isArray(field.enum) ||
                field.enum.length === 0 ||
                !field.enum.every(
                    (item) =>
                        typeof item === (type === "integer" ? "number" : type) &&
                        (type !== "integer" || Number.isInteger(item)),
                ))
        )
            return [];
        return [
            {
                key,
                type,
                schema: field,
                secret:
                    schema.writeOnly === true ||
                    field.writeOnly === true ||
                    field.format === "password",
                readOnly: schema.readOnly === true || field.readOnly === true,
                required: Array.isArray(schema.required) && schema.required.includes(key),
            },
        ];
    });
}

/** Plugin-owned localized schema annotations; no executable translations or desktop catalog keys. */
export function extensionConfigText(
    schema: Record<string, unknown>,
    locale: string,
    key: "title" | "description",
    fallback = "",
): string {
    const localized = schema["x-i18n"];
    if (localized && typeof localized === "object") {
        const language = locale.toLowerCase().split(/[-_]/)[0];
        for (const candidate of [locale, locale.toLowerCase(), language, "en"]) {
            const value = (localized as Record<string, unknown>)[candidate ?? ""];
            if (
                value &&
                typeof value === "object" &&
                typeof (value as Record<string, unknown>)[key] === "string"
            )
                return (value as Record<string, string>)[key] ?? fallback;
        }
    }
    return typeof schema[key] === "string" ? (schema[key] as string) : fallback;
}

export function extensionConfigEnumNames(
    schema: Record<string, unknown>,
    locale: string,
): string[] | undefined {
    const localized = schema["x-i18n"] as Record<string, { enumNames?: unknown }> | undefined;
    for (const candidate of [
        locale,
        locale.toLowerCase(),
        locale.toLowerCase().split(/[-_]/)[0],
        "en",
    ]) {
        const names = localized?.[candidate ?? ""]?.enumNames;
        if (Array.isArray(names) && names.every((name) => typeof name === "string")) return names;
    }
    return Array.isArray(schema.enumNames) &&
        schema.enumNames.every((name) => typeof name === "string")
        ? schema.enumNames
        : undefined;
}
