/**
 * EmptyChatState — centered logo + rotating slogan shown in <main> when the
 * active chat has no messages yet. Slogan pool is language-aware: each UI
 * language ships its own list under `session.slogans` and only that pool
 * cycles through the rotator, so the user never sees a sentence in the
 * wrong language between rotations.
 */

import { useEffect, useState } from "react";
import taco from "../assets/taco.png";
import { useT, useUiLanguage } from "../i18n/useI18n";

const ROTATE_MS = 2000;
const FALLBACK_SLOGAN = "Type a prompt and start a new chat.";

export function EmptyChatState() {
    const { t } = useT();
    const lang = useUiLanguage();
    // returnObjects: true returns the array as-is when the key holds a
    // JSON array. Both locale files declare `session.slogans` as an array
    // of plain strings, but TypeScript types it as unknown — coerce with
    // an Array.isArray guard so a future shape change degrades to the
    // fallback text instead of crashing.
    const raw = t("session.slogans", { returnObjects: true }) as unknown;
    const slogans: string[] = Array.isArray(raw)
        ? raw.filter((s): s is string => typeof s === "string")
        : [];
    // Reset to 0 when language flips so the rotator doesn't resume mid-pool
    // (otherwise swapping UI language could land on index=2 of a 3-item pool).
    const [index, setIndex] = useState(0);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `lang` is the explicit trigger — it is read off React state outside the effect body so biome's static analysis can't see it, but we re-run only on language change to reset the index.
    useEffect(() => {
        setIndex(0);
    }, [lang]);

    useEffect(() => {
        if (slogans.length <= 1) return;
        const id = window.setInterval(() => {
            setIndex((i) => (i + 1) % slogans.length);
        }, ROTATE_MS);
        return () => window.clearInterval(id);
    }, [slogans.length]);

    const slogan = slogans[index] ?? slogans[0] ?? FALLBACK_SLOGAN;

    return (
        <div className="empty-chat-state">
            <img src={taco} alt="" className="empty-chat-state__logo" />
            {/* key={index} retriggers the CSS fade so each slogan swap animates. */}
            <p key={`${lang}-${index}`} className="empty-chat-state__slogan">
                {slogan}
            </p>
        </div>
    );
}
