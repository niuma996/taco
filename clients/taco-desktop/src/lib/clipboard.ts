/** Write text to the clipboard, with a legacy WebView fallback. */
export async function writeToClipboard(value: string): Promise<boolean> {
    try {
        if (
            typeof navigator !== "undefined" &&
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === "function"
        ) {
            await navigator.clipboard.writeText(value);
            return true;
        }
    } catch {
        // Fall through when the browser/user agent denies clipboard access.
    }
    try {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        textarea.style.pointerEvents = "none";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(textarea);
        return copied;
    } catch {
        return false;
    }
}
