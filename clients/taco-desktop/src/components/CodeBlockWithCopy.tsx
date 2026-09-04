/**
 * react-markdown `components.pre` override — wraps fenced code blocks with a
 * copy-button header above the shiki tokenized `<pre>`.
 *
 * Overrides `pre` (not `code`): react-markdown v10 removed the `inline` prop
 * older overrides used to branch on, and rehype-shiki swaps the whole `<pre>`
 * for a fragment whose className is `shiki …` (no `language-xxx`), leaving no
 * reliable inline detection on `code`. Fenced blocks fire `pre`; inline code
 * never wraps in `<pre>`.
 *
 * Language tag comes from the shiki `captureLanguage` transformer in
 * `AssistantMarkdown`, which tags shiki's own `<pre>` output — a rehype
 * plugin running before shiki would write onto the node shiki discards.
 * hast's `dataLanguage` property arrives here as the `data-language` prop.
 */

import { Check, Copy, X } from "lucide-react";
import {
    Children,
    type ComponentProps,
    isValidElement,
    type ReactNode,
    useEffect,
    useRef,
    useState,
} from "react";

type PreProps = ComponentProps<"pre"> & {
    /** Destructured so it is not spread onto the DOM (React 19 warns otherwise). */
    node?: unknown;
    /** Set by the shiki `captureLanguage` transformer (e.g. "python"). */
    "data-language"?: string;
};

type CopyState = "idle" | "copied" | "failed";

/**
 * Recursively collect text from React children that arrive as a tree of
 * token spans produced by shiki. Returns the concatenated plain string.
 */
function collectText(children: ReactNode): string {
    let out = "";
    Children.forEach(children, (child) => {
        if (typeof child === "string" || typeof child === "number") {
            out += String(child);
        } else if (isValidElement(child)) {
            out += collectText((child.props as { children?: ReactNode }).children);
        }
    });
    return out;
}

/**
 * Write `value` to the clipboard, preferring `navigator.clipboard` and falling
 * back to a hidden-textarea + `execCommand("copy")` for environments where
 * the clipboard API is unavailable (older WebViews, Tauri without clipboard
 * permission).
 */
async function writeToClipboard(value: string): Promise<boolean> {
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
        // fall through to the legacy path
    }
    try {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        ta.style.pointerEvents = "none";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

function CodeCopyButton({ value }: { value: string }) {
    const [state, setState] = useState<CopyState>("idle");
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (timerRef.current !== null) clearTimeout(timerRef.current);
        },
        [],
    );

    const handleClick = async () => {
        const ok = await writeToClipboard(value);
        setState(ok ? "copied" : "failed");
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            setState("idle");
            timerRef.current = null;
        }, 1500);
    };

    const Icon = state === "copied" ? Check : state === "failed" ? X : Copy;
    return (
        <button
            type="button"
            className="md-copy-btn"
            onClick={handleClick}
            aria-label="Copy code"
            title="Copy"
            data-state={state}
        >
            <Icon size={13} aria-hidden="true" />
        </button>
    );
}

export function CodeBlockWithCopy(props: PreProps) {
    const {
        className,
        children,
        ref: _ref,
        node: _node,
        "data-language": language,
        ...rest
    } = props;
    const codeText = collectText(children);
    const label = language && language.length > 0 ? language : "code";

    return (
        <div className="md-code-block">
            <div className="md-code-header">
                <span className="md-code-lang">{label}</span>
                <CodeCopyButton value={codeText} />
            </div>
            <pre className={className} {...rest}>
                {children}
            </pre>
        </div>
    );
}
