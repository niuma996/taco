/**
 * ActivityRail — narrow left icon column spanning the full window height.
 *
 * Entries: chat (default) then agents/skills/tools/mcp/plugins/channels in
 * the top group, a single "more" button collapsing memory/checkpoints/
 * schedules, and settings pinned to the bottom group. Top padding is driven
 * by --rail-top-padding (36px on macOS to align with the traffic-light center).
 *
 * The rail is too narrow to hold labels, so each button surfaces its label in
 * a tooltip on hover/focus instead of rendering it inline.
 */

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
    Bot,
    Brain,
    CalendarClock,
    Check,
    History,
    MessageSquare,
    MoreHorizontal,
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
    labelKey: string;
};

/** Views behind the "more" button — they have no rail slot of their own. */
const OVERFLOW_VIEWS: ReadonlyArray<ActivityView> = ["memory", "checkpoints", "schedules"];

const CHAT_ITEM: ItemDef = { type: "chat", icon: MessageSquare, labelKey: "activity.chat" };

const TOP_ITEMS: ReadonlyArray<ItemDef> = [
    { type: "agents", icon: Bot, labelKey: "activity.agents" },
    { type: "skills", icon: Sparkles, labelKey: "activity.skills" },
    { type: "tools", icon: Wrench, labelKey: "activity.tools" },
    { type: "mcp", icon: Server, labelKey: "activity.mcp" },
    { type: "plugins", icon: Plug, labelKey: "activity.plugins" },
    { type: "channels", icon: Radio, labelKey: "activity.channels" },
];

const OVERFLOW_ITEMS: ReadonlyArray<ItemDef> = [
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
            aria-pressed={activeView === type}
        >
            {/* Background layer: square that turns orange on hover/active, no clipping. */}
            <span className="activity-rail-bg" aria-hidden="true" />
            {/* Content layer: icon centered over the background. */}
            <span className="activity-rail-content">
                <Icon size={20} aria-hidden="true" />
            </span>
            {/* Label lives in a tooltip so the narrow rail never has to fit text. */}
            <span className="activity-rail-tooltip" role="tooltip">
                {label}
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
    // An overflow view keeps the "more" button lit so the current location stays visible.
    const overflowActive = OVERFLOW_VIEWS.includes(activeView);
    return (
        <nav className="activity-rail" aria-label="Activity rail">
            <div className="activity-rail-top">
                <RailButton {...CHAT_ITEM} activeView={activeView} onSelect={onSelect} t={t} />
                {/* Divider between chat and the rest of the top group; aligns with the settings border. */}
                <div className="activity-rail-divider" aria-hidden="true" />
                {TOP_ITEMS.map((item) => (
                    <RailButton
                        key={item.type}
                        {...item}
                        activeView={activeView}
                        onSelect={onSelect}
                        t={t}
                    />
                ))}
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                        <button
                            type="button"
                            className={`activity-rail-item${overflowActive ? " active" : ""}`}
                            aria-pressed={overflowActive}
                        >
                            <span className="activity-rail-bg" aria-hidden="true" />
                            <span className="activity-rail-content">
                                <MoreHorizontal size={20} aria-hidden="true" />
                            </span>
                            <span className="activity-rail-tooltip" role="tooltip">
                                {t("activity.more")}
                            </span>
                        </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                        <DropdownMenu.Content
                            className="ui-menu"
                            side="right"
                            sideOffset={6}
                            align="start"
                        >
                            {OVERFLOW_ITEMS.map(({ type, icon: Icon, labelKey }) => (
                                <DropdownMenu.Item
                                    key={type}
                                    className="ui-menu-item"
                                    onSelect={() => onSelect(type)}
                                >
                                    <Icon size={16} aria-hidden="true" />
                                    <span className="ui-menu-label">{t(labelKey)}</span>
                                    {activeView === type ? (
                                        <Check size={14} aria-hidden="true" />
                                    ) : null}
                                </DropdownMenu.Item>
                            ))}
                        </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                </DropdownMenu.Root>
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
