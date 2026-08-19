/**
 * ActivityRail — left-side 78px icon column spanning the full window height.
 *
 * Entries: chat (default), memory, tools, skills, agents, plugins in the top
 * group; settings pinned to the bottom group. Top padding is driven by
 * --rail-top-padding (36px on macOS to align with the traffic-light center),
 * so the rail no longer needs to be pushed down 40px.
 */

import {
    Bot,
    Brain,
    CalendarClock,
    History,
    MessageSquare,
    Plug,
    Radio,
    Server,
    Settings,
    Sparkles,
    Wrench,
} from "lucide-react";

import { useT } from "../i18n/useI18n";

type ActivityView =
    | "chat"
    | "tools"
    | "skills"
    | "agents"
    | "plugins"
    | "channels"
    | "memory"
    | "checkpoints"
    | "schedules"
    | "mcp"
    | "settings";

type ItemDef = {
    type: ActivityView;
    icon: typeof MessageSquare;
    labelKey:
        | "activity.chat"
        | "activity.tools"
        | "activity.skills"
        | "activity.agents"
        | "activity.plugins"
        | "activity.channels"
        | "activity.memory"
        | "activity.checkpoints"
        | "activity.schedules"
        | "activity.mcp"
        | "activity.settings";
};

const ACTIVITY_ITEMS: ReadonlyArray<ItemDef> = [
    { type: "chat", icon: MessageSquare, labelKey: "activity.chat" },
    { type: "agents", icon: Bot, labelKey: "activity.agents" },
    { type: "skills", icon: Sparkles, labelKey: "activity.skills" },
    { type: "tools", icon: Wrench, labelKey: "activity.tools" },
    { type: "mcp", icon: Server, labelKey: "activity.mcp" },
    { type: "plugins", icon: Plug, labelKey: "activity.plugins" },
    { type: "channels", icon: Radio, labelKey: "activity.channels" },
    { type: "memory", icon: Brain, labelKey: "activity.memory" },
    { type: "checkpoints", icon: History, labelKey: "activity.checkpoints" },
    { type: "schedules", icon: CalendarClock, labelKey: "activity.schedules" },
];

const SETTINGS_ITEM: ItemDef = { type: "settings", icon: Settings, labelKey: "activity.settings" };

export interface ActivityRailProps {
    activeView: ActivityView;
    onSelect: (view: ActivityView) => void;
    /** When true, the Settings item shows a small status dot. Wired to
     *  the updater's "available" state by App.tsx so the user can see
     *  at a glance that an update is pending without an auto-popup. */
    hasUpdateBadge?: boolean;
}

function RailButton({
    type,
    icon: Icon,
    labelKey,
    activeView,
    onSelect,
    t,
    badge,
}: ItemDef & {
    activeView: ActivityView;
    onSelect: (view: ActivityView) => void;
    t: (k: string) => string;
    /** When set, render a small status dot in the button's top-right
     *  corner. The Settings item uses this for the "update available"
     *  badge — App.tsx passes `hasUpdateBadge` through conditionally. */
    badge?: boolean;
}) {
    const label = t(labelKey);
    return (
        <button
            type="button"
            className={`activity-rail-item${activeView === type ? " active" : ""}`}
            onClick={() => onSelect(type)}
            title={label}
            aria-pressed={activeView === type}
        >
            {/* Background layer: 64x64 square that turns orange on hover/active, no clipping. */}
            <span className="activity-rail-bg" aria-hidden="true" />
            {/* Content layer: icon + label, centered over the background and allowed to overflow. */}
            <span className="activity-rail-content">
                <Icon size={22} aria-hidden="true" />
                <span className="activity-rail-label">{label}</span>
            </span>
            {badge ? (
                <span
                    className="activity-rail-badge"
                    aria-label={t("activity.badgeUpdateAvailable")}
                />
            ) : null}
        </button>
    );
}

export function ActivityRail({ activeView, onSelect, hasUpdateBadge }: ActivityRailProps) {
    const { t } = useT();
    // Render chat separately so the divider between it and the rest of the top
    // group can live as a sibling element — no Fragment, which trips up Vite
    // Fast Refresh when added to an existing component mid-HMR.
    const chatItem = ACTIVITY_ITEMS[0];
    const restItems = ACTIVITY_ITEMS.slice(1);
    return (
        <nav className="activity-rail" aria-label="Activity rail">
            <div className="activity-rail-top">
                {chatItem && (
                    <RailButton {...chatItem} activeView={activeView} onSelect={onSelect} t={t} />
                )}
                {/* Divider between chat and the rest of the top group; aligns with the settings border. */}
                {chatItem && <div className="activity-rail-divider" aria-hidden="true" />}
                {restItems.map((item) => (
                    <RailButton
                        key={item.type}
                        {...item}
                        activeView={activeView}
                        onSelect={onSelect}
                        t={t}
                    />
                ))}
            </div>
            <div className="activity-rail-bottom">
                <RailButton
                    {...SETTINGS_ITEM}
                    activeView={activeView}
                    onSelect={onSelect}
                    t={t}
                    badge={hasUpdateBadge}
                />
            </div>
        </nav>
    );
}
