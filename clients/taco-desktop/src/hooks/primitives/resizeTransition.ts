/**
 * Resize suppression — tells CSS to drop the panel width transition while the
 * width is being changed by something other than a layout animation.
 *
 * The panel width is a share of the chat area, so it changes whenever the
 * sidebar collapses or the window resizes. Those two want a transition (the
 * sidebar wipe drags the panel along with it), but the other two paths do not:
 *
 * - A live drag must track the pointer, not lag behind it.
 * - A keyboard step must land on the new width at once; animating it makes
 *   the panel crawl after each key press.
 * - A window resize re-derives the width on every frame, and animating each
 *   of those leaves the panel trailing the window edge.
 *
 * The mark has to outlive the frame that writes the new width — CSS resolves
 * the transition property during layout, so clearing it in the same tick
 * would let the transition start after all. Clearing it on the next frame
 * guarantees the width has already been laid out without the transition.
 *
 * A drag and a window resize can overlap, so holders are counted: the mark
 * survives until the last one lets go.
 */

/** Marks the body so CSS can drop panel transitions. */
export const RESIZING_ATTRIBUTE = "data-panel-resizing";

/** Live suppression holders. The mark is set while any of them is held. */
let holders = 0;

function sync(): void {
    if (holders > 0) {
        document.body.setAttribute(RESIZING_ATTRIBUTE, "true");
    } else {
        document.body.removeAttribute(RESIZING_ATTRIBUTE);
    }
}

/**
 * Run `apply` with the panel transition suppressed, releasing the mark once
 * the new width has been laid out.
 *
 * The mark is set before `apply` so the layout that follows sees it, and
 * cleared on the next frame so the transition cannot start on that width.
 */
export function applyWithoutTransition(apply: () => void): void {
    holders += 1;
    sync();
    apply();
    requestAnimationFrame(() => {
        holders -= 1;
        sync();
    });
}

/**
 * Hold the suppression mark until the returned function releases it.
 *
 * Used for the window resize, where the width is re-derived on every frame
 * of the drag: releasing between frames would restart the transition each
 * time and the panel would never catch up. The handle is idempotent — calling
 * release twice does not drop another holder's mark.
 */
export function holdTransitionSuppressed(): () => void {
    holders += 1;
    sync();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holders -= 1;
        sync();
    };
}
