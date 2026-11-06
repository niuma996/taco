import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryDreamPanel } from "../../src/components/memory/MemoryDreamPanel";
import en from "../../src/i18n/locales/en.json";
import zh from "../../src/i18n/locales/zh.json";

afterEach(cleanup);

it("translates consolidation settings and updates them when the UI language changes", async () => {
    const i18n = createInstance();
    await i18n.use(initReactI18next).init({
        lng: "zh",
        fallbackLng: "en",
        resources: { zh: { translation: zh }, en: { translation: en } },
        interpolation: { escapeValue: false },
    });
    render(
        <I18nextProvider i18n={i18n}>
            <MemoryDreamPanel
                busy={null}
                scheduled
                onRun={vi.fn()}
                onApply={vi.fn()}
                onDiscard={vi.fn()}
                onUndo={vi.fn()}
                onScheduleToggle={vi.fn()}
                onSaveConfig={vi.fn(async () => true)}
                onClose={vi.fn()}
                dreamConfig={{
                    minHours: 24,
                    staleDays: 90,
                    staleDaysDurable: 180,
                    archiveCleanupEnabled: true,
                    archiveRetentionDays: 7,
                }}
            />
        </I18nextProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "记忆整理设置" }));
    expect(screen.getByLabelText("最短整理间隔（小时）")).toBeTruthy();
    expect(screen.getByLabelText("项目与参考记忆闲置天数")).toBeTruthy();
    expect(screen.getByLabelText("用户偏好与反馈记忆闲置天数")).toBeTruthy();
    expect(screen.getByLabelText("删除过期的已归档记忆")).toBeTruthy();
    expect(screen.getByLabelText("归档保留时间")).toBeTruthy();
    expect(screen.getByLabelText("归档保留时间").textContent).toContain("7 天");
    expect(i18n.t("memory.dream.archiveRetention30")).toBe("30 天");
    expect(i18n.t("memory.dream.archiveRetention90")).toBe("90 天");
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();

    await act(() => i18n.changeLanguage("en"));
    expect(screen.getByRole("button", { name: "Memory consolidation settings" })).toBeTruthy();
    expect(screen.getByLabelText("Minimum hours between evaluations")).toBeTruthy();
    expect(screen.getByLabelText("Project/reference idle days")).toBeTruthy();
    expect(screen.getByLabelText("User/feedback idle days")).toBeTruthy();
    expect(screen.getByLabelText("Delete expired archived memories")).toBeTruthy();
    expect(screen.getByLabelText("Archive retention")).toBeTruthy();
    expect(screen.getByLabelText("Archive retention").textContent).toContain("7 days");
    expect(i18n.t("memory.dream.archiveRetention30")).toBe("30 days");
    expect(i18n.t("memory.dream.archiveRetention90")).toBe("90 days");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
});
