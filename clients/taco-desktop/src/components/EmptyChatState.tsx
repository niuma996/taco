/**
 * EmptyChatState — centered logo + typing slogan shown in <main> when the
 * active chat has no messages yet. Slogan pool is language-aware: each UI
 * language ships its own list under `session.slogans` and only that pool
 * cycles through the rotator, so the user never sees a sentence in the
 * wrong language between rotations.
 */

import { useEffect, useState } from "react";
import taco from "../assets/taco.png";
import { useT, useUiLanguage } from "../i18n/useI18n";

const TYPE_MS = 45;
const HOLD_MS = 2000;
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
    const pool = slogans.length > 0 ? slogans : [FALLBACK_SLOGAN];
    // Reset when language flips so the rotator doesn't resume mid-pool
    // (otherwise swapping UI language could land on index=2 of a 3-item pool).
    const [index, setIndex] = useState(0);
    const [typed, setTyped] = useState(0);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `lang` is the explicit trigger — it is read off React state outside the effect body so biome's static analysis can't see it, but we re-run only on language change to reset the index.
    useEffect(() => {
        setIndex(0);
        setTyped(0);
    }, [lang]);

    const slogan = pool[index % pool.length];

    // One timer at a time, either advancing the caret by a character or —
    // once the sentence is complete — holding it for HOLD_MS before moving
    // to the next slogan.
    useEffect(() => {
        if (typed < slogan.length) {
            const id = window.setTimeout(() => setTyped((n) => n + 1), TYPE_MS);
            return () => window.clearTimeout(id);
        }
        const id = window.setTimeout(() => {
            // A single-slogan locale has nothing to rotate to — leave the
            // finished line on screen instead of retyping it forever.
            if (pool.length <= 1) return;
            setTyped(0);
            setIndex((i) => (i + 1) % pool.length);
        }, HOLD_MS);
        return () => window.clearTimeout(id);
    }, [typed, slogan, pool.length]);

    return (
        <div className="empty-chat-state">
            <img src={taco} alt="" className="empty-chat-state__logo" />
            {/* key={index} retriggers the CSS fade so each slogan swap animates. */}
            <p key={`${lang}-${index}`} className="empty-chat-state__slogan">
                {slogan.slice(0, typed)}
            </p>
        </div>
    );
}
