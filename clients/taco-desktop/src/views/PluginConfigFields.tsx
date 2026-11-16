import {
    type ExtensionConfigField,
    type ExtensionConfigResult,
    extensionConfigEnumNames,
    extensionConfigText,
} from "@taco-ai/protocol";
import type { ComponentProps } from "react";
import { Button } from "../components/ui/Button";
import { FormField } from "../components/ui/FormField";
import { Select } from "../components/ui/Select";
import { Switch } from "../components/ui/Switch";
import { TextInput } from "../components/ui/TextInput";
import type { useT } from "../i18n/useI18n";

export function PluginConfigFields({
    fields,
    result,
    draft,
    errors,
    disabled,
    onChange,
    onReset,
    t,
    locale,
}: {
    fields: ExtensionConfigField[];
    result: ExtensionConfigResult;
    draft: Record<string, string | boolean>;
    errors: Record<string, string>;
    disabled: boolean;
    onChange: (key: string, value: string | boolean) => void;
    onReset: (field: ExtensionConfigField) => void;
    t: ReturnType<typeof useT>["t"];
    locale: string;
}) {
    return (
        <div className="plugins-config-fields">
            {fields.map((field) => {
                const label = extensionConfigText(field.schema, locale, "title", field.key);
                const description = extensionConfigText(field.schema, locale, "description");
                const enumValues = field.schema.enum as
                    | Array<string | number | boolean>
                    | undefined;
                const names = extensionConfigEnumNames(field.schema, locale);
                const value = draft[field.key] ?? "";
                const readonly = disabled || field.readOnly;
                const reset = (
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={readonly || field.required}
                        onClick={() => onReset(field)}
                    >
                        {t("plugins.resetConfigField")}
                    </Button>
                );
                let control: ComponentProps<typeof FormField>["children"];
                if (enumValues)
                    control = (
                        <Select
                            label={label}
                            value={
                                value === "" &&
                                !Object.hasOwn(result.values, field.key) &&
                                field.schema.default === undefined
                                    ? ""
                                    : `value:${String(value)}`
                            }
                            disabled={readonly}
                            placeholder={
                                field.secret && result.configuredSecrets.includes(field.key)
                                    ? t("plugins.configSecretStored")
                                    : t("plugins.configUnset")
                            }
                            options={enumValues.map((option, index) => ({
                                value: `value:${String(option)}`,
                                label: names?.[index] ?? String(option),
                            }))}
                            onValueChange={(next) => onChange(field.key, next.slice(6))}
                        />
                    );
                else if (field.type === "boolean")
                    control = (
                        <Switch
                            label={label}
                            checked={value === true}
                            disabled={readonly}
                            onChange={(next) => onChange(field.key, next)}
                        />
                    );
                else
                    control = (
                        <TextInput
                            type={
                                field.secret
                                    ? "password"
                                    : field.type === "string"
                                      ? "text"
                                      : "number"
                            }
                            value={String(value)}
                            disabled={readonly}
                            autoComplete={field.secret ? "new-password" : "off"}
                            min={
                                typeof field.schema.minimum === "number"
                                    ? field.schema.minimum
                                    : undefined
                            }
                            max={
                                typeof field.schema.maximum === "number"
                                    ? field.schema.maximum
                                    : undefined
                            }
                            step={field.type === "integer" ? 1 : "any"}
                            placeholder={
                                field.secret && result.configuredSecrets.includes(field.key)
                                    ? t("plugins.configSecretStored")
                                    : undefined
                            }
                            onChange={(event) => onChange(field.key, event.target.value)}
                        />
                    );
                return (
                    <FormField
                        key={field.key}
                        label={label}
                        hint={description || undefined}
                        error={errors[field.key] ? t(errors[field.key]) : undefined}
                        action={reset}
                    >
                        {control}
                    </FormField>
                );
            })}
        </div>
    );
}
