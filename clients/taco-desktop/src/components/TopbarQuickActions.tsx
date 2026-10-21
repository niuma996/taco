/**
 * TopbarQuickActions — workspace approvals, notification bell, and language /
 * theme shortcuts in the title bar.
 *
 * The approvals button sits left of the bell and is always shown, so there is
 * one fixed place to check for commands blocked in any workspace.
 * Language and theme each open a Radix dropdown (same pattern as
 * WorkspacePicker) and write through `writeClientSettings`, so AppearanceTab,
 * useTheme, and i18n subscribers update in place — no sidecar RPC.
 *
 * The bell forwards each newly arrived notification to `onNewNotification` so
 * App can decide whether it is worth a toast; the bell itself stays a passive
 * reader of the store.
 *
 * Placement is the topbar flex flow (after the drag spacer). Windows/Linux
 * keep them left of the fixed min/max/close cluster via extra topbar
 * padding-right; macOS pins them to the window's right edge.
 */

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Languages, Monitor, Moon, ShieldQuestionMark, Sun } from "lucide-react";
import type { ReactNode } from "react";

import { useGlobalConfig } from "../hooks/primitives/useGlobalConfig.ts";
import { SUPPORTED_UI_LANGUAGES, type SupportedUiLanguage } from "../i18n/index.ts";
import { useT, useUiLanguage } from "../i18n/useI18n.ts";
import type { ThemePreference } from "../lib/clientSettings.ts";
import { writeClientSettings } from "../lib/globalConfig.ts";
import type { AppNotification, ApprovalNotificationTarget } from "../lib/notifications.ts";
import { NotificationBell } from "./NotificationBell.tsx";
import { IconButton } from "./ui/IconButton.tsx";

const THEME_OPTIONS: ReadonlyArray<{
    value: ThemePreference;
    labelKey:
        | "settings.themeOptionLight"
        | "settings.themeOptionDark"
        | "settings.themeOptionSystem";
}> = [
    { value: "light", labelKey: "settings.themeOptionLight" },
    { value: "dark", labelKey: "settings.themeOptionDark" },
    { value: "system", labelKey: "settings.themeOptionSystem" },
];

function ThemeIcon({ pref }: { pref: ThemePreference }) {
    if (pref === "light") return <Sun size={14} aria-hidden="true" />;
    if (pref === "dark") return <Moon size={14} aria-hidden="true" />;
    return <Monitor size={14} aria-hidden="true" />;
}

function QuickMenu({
    label,
    icon,
    items,
    value,
    onSelect,
}: {
    label: string;
    icon: ReactNode;
    items: ReadonlyArray<{ value: string; label: string }>;
    value: string;
    onSelect: (value: string) => void;
}) {
    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <IconButton size="lg" aria-label={label} title={label}>
                    {icon}
                </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content className="topbar-quick-menu" sideOffset={4} align="end">
                    {items.map((item) => (
                        <DropdownMenu.Item
                            key={item.value}
                            className="topbar-workspace-item"
                            onSelect={() => onSelect(item.value)}
                        >
                            <span className="topbar-workspace-item-check">
                                {item.value === value && <Check size={12} aria-hidden="true" />}
                            </span>
                            <span className="topbar-workspace-item-label">{item.label}</span>
                        </DropdownMenu.Item>
                    ))}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}

export interface TopbarQuickActionsProps {
    notifications: AppNotification[];
    pendingApprovalCount?: number;
    onOpenPendingApprovals?: () => void;
    onOpenApproval?: (target: ApprovalNotificationTarget) => void;
    onDismissNotification: (id: number) => void;
    onClearNotifications: () => void;
    /**
     * Receives each row that lands while the bell is closed. App toasts the
     * ones `toastsOnArrival` selects; the rest are left to the badge.
     */
    onNewNotification?: (notification: AppNotification) => void;
}

export function TopbarQuickActions({
    notifications,
    pendingApprovalCount = 0,
    onOpenPendingApprovals,
    onDismissNotification,
    onClearNotifications,
    onNewNotification,
    onOpenApproval,
}: TopbarQuickActionsProps) {
    const { t } = useT();
    const uiLanguage = useUiLanguage();
    const theme: ThemePreference = useGlobalConfig().client.theme ?? "system";

    return (
        <div className="topbar-quick-actions">
            {onOpenPendingApprovals && (
                <IconButton
                    size="lg"
                    className={
                        pendingApprovalCount > 0
                            ? "workspace-approval-button workspace-approval-button--pending"
                            : "workspace-approval-button"
                    }
                    aria-label={t("session.pendingPermissions")}
                    title={t("session.pendingPermissions")}
                    onClick={onOpenPendingApprovals}
                >
                    <span className="workspace-approval-button__icon">
                        <ShieldQuestionMark size={14} aria-hidden="true" />
                        {pendingApprovalCount > 0 && (
                            <span className="workspace-approval-button__count" aria-hidden="true">
                                {pendingApprovalCount > 99 ? "99+" : pendingApprovalCount}
                            </span>
                        )}
                    </span>
                </IconButton>
            )}
            <NotificationBell
                notifications={notifications}
                onDismiss={onDismissNotification}
                onClearAll={onClearNotifications}
                onNewArrival={onNewNotification}
                onOpenApproval={onOpenApproval}
            />
            <QuickMenu
                label={t("app.language")}
                icon={<Languages size={14} aria-hidden="true" />}
                value={uiLanguage}
                items={SUPPORTED_UI_LANGUAGES.map((lng) => ({
                    value: lng,
                    label:
                        lng === "zh"
                            ? t("settings.languageOptionZh")
                            : t("settings.languageOptionEn"),
                }))}
                onSelect={(next) =>
                    void writeClientSettings({ uiLanguage: next as SupportedUiLanguage })
                }
            />
            <QuickMenu
                label={t("app.theme")}
                icon={<ThemeIcon pref={theme} />}
                value={theme}
                items={THEME_OPTIONS.map((o) => ({
                    value: o.value,
                    label: t(o.labelKey),
                }))}
                onSelect={(next) => void writeClientSettings({ theme: next as ThemePreference })}
            />
        </div>
    );
}
