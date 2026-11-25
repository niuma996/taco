/**
 * ProviderIcon — fallback badge tests.
 *
 * The brand-mark path is a CSS mask with no inline SVG; the fallback path is
 * where the logic lives: which letter a provider badge gets, and when the
 * neutral glyph takes over.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ProviderIcon } from "../../../src/components/settings/ProviderIcon.tsx";

afterEach(cleanup);

describe("ProviderIcon", () => {
    it("badges a custom provider with its name's initial", () => {
        const { container } = render(<ProviderIcon providerId="custom:acme" name="Acme Corp" />);
        expect(container.querySelector(".lucide-circle-letter-a")).not.toBeNull();
    });

    it("derives the letter past a custom: id used as the name", () => {
        // The model menu groups by provider id and passes it as `name`.
        const { container } = render(<ProviderIcon providerId="custom:foo" name="custom:foo" />);
        expect(container.querySelector(".lucide-circle-letter-f")).not.toBeNull();
    });

    it("falls back to the neutral glyph when the name has no ASCII letter", () => {
        const { container } = render(<ProviderIcon providerId="custom:x" name="深度求索" />);
        expect(container.querySelector(".lucide-box")).not.toBeNull();
    });
});
