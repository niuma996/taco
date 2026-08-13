/**
 * Minimal `{{VAR}}` placeholder substitution for prompt templates.
 */

/**
 * Replace every `{{KEY}}` occurrence in `template` with `placeholders[KEY]`.
 * Keys with no matching entry are left untouched.
 */
export function fillPlaceholders(
    template: string,
    placeholders: Readonly<Record<string, string>>,
): string {
    let result = template;
    for (const [key, value] of Object.entries(placeholders)) {
        result = result.split(`{{${key}}}`).join(value);
    }
    return result;
}
