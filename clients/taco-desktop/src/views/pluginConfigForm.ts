import type {
    ExtensionConfigField,
    ExtensionConfigResult,
    ExtensionConfigValue,
} from "@taco-ai/protocol";

export function initialPluginDraft(
    fields: ExtensionConfigField[],
    result: ExtensionConfigResult,
): Record<string, string | boolean> {
    return Object.fromEntries(
        fields.map((field) => {
            const value = field.secret
                ? undefined
                : (result.values[field.key] ?? field.schema.default);
            return [
                field.key,
                field.type === "boolean" && !field.schema.enum
                    ? value === true
                    : value === undefined
                      ? ""
                      : String(value),
            ];
        }),
    );
}

export function pluginConfigPatch(
    fields: ExtensionConfigField[],
    draft: Record<string, string | boolean>,
    edited: Set<string>,
    reset: Set<string>,
): {
    values: Record<string, ExtensionConfigValue>;
    unset: string[];
    errors: Record<string, string>;
} {
    const values: Record<string, ExtensionConfigValue> = Object.create(null);
    const unset: string[] = [];
    const errors: Record<string, string> = {};
    for (const field of fields) {
        if (!edited.has(field.key) || field.readOnly) continue;
        const raw = draft[field.key];
        if (reset.has(field.key) || (raw === "" && !field.secret && !field.schema.enum)) {
            if (field.required) {
                errors[field.key] = "plugins.configInvalid";
                continue;
            }
            unset.push(field.key);
            continue;
        }
        if (field.secret && raw === "") continue;
        let value: ExtensionConfigValue;
        if (field.schema.enum) {
            const option = (field.schema.enum as ExtensionConfigValue[]).find(
                (option) => String(option) === raw,
            );
            if (option === undefined) {
                errors[field.key] = "plugins.configInvalid";
                continue;
            }
            value = option;
        } else if (field.type === "boolean") value = raw === true;
        else if (field.type === "string") value = String(raw);
        else {
            const number = Number(raw);
            if (
                String(raw).trim() === "" ||
                !Number.isFinite(number) ||
                (field.type === "integer" && !Number.isInteger(number)) ||
                (typeof field.schema.minimum === "number" && number < field.schema.minimum) ||
                (typeof field.schema.maximum === "number" && number > field.schema.maximum)
            ) {
                errors[field.key] = "plugins.configInvalid";
                continue;
            }
            value = number;
        }
        values[field.key] = value;
    }
    return { values, unset, errors };
}
