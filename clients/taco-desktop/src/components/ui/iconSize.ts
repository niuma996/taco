// Shared props for the icon-only buttons in the top bars (session bar and
// topbar quick actions). lucide scales stroke with size (default 2 on a 24
// grid): a 16px glyph with stroke 2 would render 1.33px lines, thicker than
// the 14px glyphs these replaced (~1.17px). 1.7 keeps the rendered line
// weight at ~1.13px — same as before — while the glyph stays compact.
export const BAR_ICON = { size: 16, strokeWidth: 1.7, "aria-hidden": true } as const;
