/**
 * Product identity — the name the assistant calls itself in its own prompt.
 *
 * One field, one validator. The config read path, the patch path and the
 * startup path all call `validateProductName`; the callers differ only in
 * what a bad value means: a hand-edited config file falls back to the
 * default, while a patch or a startup argument fails loudly.
 */

/** Product name used when nothing is configured. */
export const DEFAULT_PRODUCT_NAME = "Taco";

export const PRODUCT_NAME_EDIT_GUIDANCE =
    "Ask the user to set productName in $TACO_HOME/taco.json and restart the sidecar.";

/** Maximum length of a product name, counted in Unicode code points. */
export const PRODUCT_NAME_MAX_CODE_POINTS = 80;

/**
 * Characters a name may never contain:
 *  - control and format characters (which covers tabs, CR/LF and the bidi
 *    overrides);
 *  - the Unicode line and paragraph separators;
 *  - `<`, `>` and `{}` — a name is inserted into the system prompt, so
 *    these would let it open a section or a `{{template marker}}`.
 *
 * Checked before trimming, so a trailing newline is rejected rather than
 * silently trimmed away.
 */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>{}]/u;

/**
 * Letters and combining marks from any script, numbers, ordinary spaces,
 * punctuation and symbols.
 */
const ALLOWED = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;

/**
 * Validate and normalize a product name.
 *
 * Returns the trimmed NFC name, or `undefined` when the value means "no name"
 * (`null`, `undefined`, or a blank string of ordinary spaces). Throws for
 * anything invalid — the caller decides whether that is fatal.
 */
export function validateProductName(value: unknown, source: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
        throw new Error(`invalid productName from ${source}: expected string, got ${typeof value}`);
    }
    if (FORBIDDEN.test(value)) {
        throw new Error(
            `invalid productName from ${source}: control characters, line breaks and the ` +
                "characters < > { } are not allowed",
        );
    }
    const name = value.trim().normalize("NFC");
    if (name === "") return undefined;
    if ([...name].length > PRODUCT_NAME_MAX_CODE_POINTS) {
        throw new Error(
            `invalid productName from ${source}: longer than ${PRODUCT_NAME_MAX_CODE_POINTS} Unicode code points`,
        );
    }
    if (!ALLOWED.test(name)) {
        throw new Error(
            `invalid productName from ${source}: only letters, combining marks, numbers, ` +
                "ordinary spaces, punctuation and symbols are allowed",
        );
    }
    return name;
}

/**
 * Read a stored product name leniently: an invalid stored value reads as
 * "unset" instead of throwing. A hand-edited `taco.json` must not break the
 * process that reads it.
 */
export function readStoredProductName(value: unknown): string | undefined {
    try {
        return validateProductName(value, "stored config");
    } catch {
        return undefined;
    }
}
