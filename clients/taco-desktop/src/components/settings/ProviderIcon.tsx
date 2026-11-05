/**
 * ProviderIcon — the brand mark on a provider card.
 *
 * The vendored marks are single-colour (`fill="currentColor"`), and they are
 * applied as a CSS mask over the element's background colour. That keeps the
 * mark's colour under CSS control — one rule then makes every mark legible in
 * both dark and light mode — and it avoids the two dead ends: an external SVG
 * in `mask-image` is not loaded, and an inline `<svg>` does not paint in the
 * app's WebKit view.
 *
 * The mask source is a data URI built from the path data in
 * `providerIconPaths.ts`, generated from the SVG files in
 * `assets/provider-icons/` by `scripts/generate-provider-icons.mjs`.
 *
 * Providers without a vendored mark — every custom provider, and any built-in
 * added later — fall back to a neutral glyph.
 */
import { Box } from "lucide-react";
import { PROVIDER_ICON_SHAPES } from "./providerIconPaths.ts";

/** Provider id → shape. Chinese-region variants reuse the global brand. */
const PROVIDER_SHAPES: Readonly<Record<string, keyof typeof PROVIDER_ICON_SHAPES>> = {
    anthropic: "anthropic",
    openai: "openai",
    google: "gemini",
    xai: "xai",
    deepseek: "deepseek",
    moonshotai: "moonshot",
    "moonshotai-cn": "moonshot",
    zai: "zai",
    "zai-coding-cn": "zai",
    minimax: "minimax",
    "minimax-cn": "minimax",
    openrouter: "openrouter",
};

/**
 * The mask source for one shape, as a quoted CSS `url()` value.
 *
 * Quoted because the encoded data URI contains characters that would
 * otherwise end the url() token early.
 */
function maskFor(shape: (typeof PROVIDER_ICON_SHAPES)[string]): string {
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${shape.viewBox}"` +
        ` fill="currentColor" fill-rule="${shape.fillRule}">` +
        shape.paths.map((d) => `<path d="${d}"/>`).join("") +
        "</svg>";
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export interface ProviderIconProps {
    /** Provider id as reported by the sidecar (`custom:…` for user-defined ones). */
    providerId: string;
    /** Provider name, kept for the accessible label on the card. */
    name: string;
}

/**
 * Render the provider's brand mark, or a neutral placeholder when the
 * provider has none. The card is a button that already carries an
 * accessible name, so the mark itself is decorative.
 */
export function ProviderIcon(props: ProviderIconProps) {
    const key = PROVIDER_SHAPES[props.providerId];
    const shape = key ? PROVIDER_ICON_SHAPES[key] : undefined;
    if (!shape) {
        return (
            <span className="provider-icon provider-icon--fallback" aria-hidden="true">
                <Box size={16} strokeWidth={1.7} />
            </span>
        );
    }
    const mask = maskFor(shape);
    return (
        <span
            className="provider-icon"
            style={{ maskImage: mask, WebkitMaskImage: mask }}
            aria-hidden="true"
        />
    );
}
