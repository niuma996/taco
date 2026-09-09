/// <reference types="vite/client" />
/**
 * EmptyChatState — centered logo + rotating slogan shown in <main> when the
 * active chat has no messages yet (fresh session, or a session created but
 * never prompted). Slogans are deliberately bilingual regardless of the UI
 * language setting — this is a splash-style flourish, not translated content.
 */

import { useEffect, useState } from "react";
import taco from "../assets/taco.png";

const ROTATE_MS = 2000;

const SLOGANS = [
    "Turning your ideas into working code.",
    "让想法快速变成可运行的代码。",
    "Ask anything about your codebase.",
    "随时向你的代码库提问。",
    "Ship faster, debug smarter.",
    "更快交付，更聪明地排错。",
];

export function EmptyChatState() {
    const [index, setIndex] = useState(0);

    useEffect(() => {
        const id = window.setInterval(() => {
            setIndex((i) => (i + 1) % SLOGANS.length);
        }, ROTATE_MS);
        return () => window.clearInterval(id);
    }, []);

    return (
        <div className="empty-chat-state">
            <img src={taco} alt="" className="empty-chat-state__logo" />
            {/* key={index} retriggers the CSS fade so each slogan swap animates. */}
            <p key={index} className="empty-chat-state__slogan">
                {SLOGANS[index]}
            </p>
        </div>
    );
}
