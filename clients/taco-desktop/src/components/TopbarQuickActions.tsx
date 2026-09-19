/**
 * TopbarQuickActions — language + theme shortcuts in the title bar.
 *
 * Two icon buttons, each opening a Radix dropdown (same pattern as
 * WorkspacePicker). Writes go through `writeClientSettings` so AppearanceTab,
 * useTheme, and i18n subscribers update in place — no sidecar RPC.
 *
 * Placement is the topbar flex flow (after the drag spacer). Windows/Linux
 * keep them left of the fixed min/max/close cluster via extra topbar
 * padding-right; macOS pins them to the window's right edge.
 */

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Languages, Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";

import { useGlobalConfig } from "../hooks/primitives/useGlobalConfig.ts";
import { SUPPORTED_UI_LANGUAGES, type SupportedUiLanguage } from "../i18n/index.ts";
import { useT, useUiLanguage } from "../i18n/useI18n.ts";
import type { ThemePreference } from "../lib/clientSettings.ts";
import { writeClientSettings } from "../lib/globalConfig.ts";

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
            <DropdownMenu.Trigger className="topbar-quick-btn" aria-label={label} title={label}>
                {icon}
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

export function TopbarQuickActions() {
    const { t } = useT();
    const uiLanguage = useUiLanguage();
    const theme: ThemePreference = useGlobalConfig().client.theme ?? "system";

    return (
        <div className="topbar-quick-actions">
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
