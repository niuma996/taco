/**
 * Pull a JSON value out of model output that may include fences or surrounding
 * prose. The bracket pair is a parameter so object (`{...}`) and array (`[...]`)
 * callers share one three-tier strategy: direct parse → fenced block → first
 * matching span. Returns `null` when no parseable JSON is found.
 */
export function extractJsonSpan(raw: string, brackets: "[]" | "{}"): unknown {
    const [open, close] = brackets === "[]" ? ("[]" as const) : ("{}" as const);
    const trimmed = raw.trim();
    // Direct JSON
    try {
        return JSON.parse(trimmed);
    } catch {
        // not JSON
    }
    // Fenced JSON
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
    if (fenced?.[1]) {
        try {
            return JSON.parse(fenced[1]);
        } catch {
            // fall through
        }
    }
    // First <open>...</close> span
    const first = trimmed.indexOf(open);
    const last = trimmed.lastIndexOf(close);
    if (first >= 0 && last > first) {
        try {
            return JSON.parse(trimmed.slice(first, last + 1));
        } catch {
            // fall through
        }
    }
    return null;
}
