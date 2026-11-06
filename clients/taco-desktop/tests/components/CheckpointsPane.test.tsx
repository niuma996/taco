import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckpointsPane } from "../../src/views/CheckpointsPane";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({
        t: (key: string) => key,
        i18n: { language: "en" },
    })),
}));

afterEach(cleanup);

const checkpoint = {
    id: "cp-1",
    sessionId: "session-old",
    createdAt: "2026-11-07T00:00:00.000Z",
    label: "turn 1",
    files: [{ path: "/workspace/src/app.ts", existed: true }],
};

describe("CheckpointsPane", () => {
    it("uses the group action for another session without rendering an inline hint", () => {
        render(
            <CheckpointsPane
                data={{ checkpoints: [checkpoint], enabled: true }}
                loading={false}
                error={null}
                restoringId={null}
                refresh={() => {}}
                restore={async () => ({ ok: true })}
                hasActiveSession
                activeSessionId="session-current"
                sessions={[]}
                onOpenSession={() => {}}
            />,
        );

        expect(screen.getByRole("button", { name: "checkpoints.openSession" })).toBeTruthy();
        expect(screen.queryByText("checkpoints.restoreNeedsCurrentSession")).toBeNull();
    });
});
