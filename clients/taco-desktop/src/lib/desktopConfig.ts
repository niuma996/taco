/**
 * Pure-desktop client configuration stored in ~/.taco/desktop.json.
 * Sidecar does not read or write this file.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export interface OnboardingStatus {
    status: "completed" | "skipped";
    completedAt?: string;
    skippedAt?: string;
}

export interface DesktopConfig {
    onboarding?: OnboardingStatus;
}

async function readRaw(): Promise<string> {
    return tauriInvoke<string>("desktop_config_read");
}

async function writeRaw(contents: string): Promise<void> {
    await tauriInvoke("desktop_config_write", { contents });
}

export async function readDesktopConfig(): Promise<DesktopConfig> {
    try {
        const raw = await readRaw();
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        if (parsed && typeof parsed === "object") {
            return parsed as DesktopConfig;
        }
    } catch (error) {
        console.error("[taco] failed to read desktop config", error);
    }
    return {};
}

export async function writeDesktopConfig(patch: Partial<DesktopConfig>): Promise<void> {
    const current = await readDesktopConfig();
    const next: DesktopConfig = { ...current, ...patch };
    await writeRaw(JSON.stringify(next, null, 2));
}

export function isOnboardingRequired(config: DesktopConfig | null): boolean {
    if (!config) return true;
    return config.onboarding?.status !== "completed" && config.onboarding?.status !== "skipped";
}
