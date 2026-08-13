import type { WorkspaceId } from "@taco-ai/protocol";
import { useT } from "../../i18n/useI18n";
import type { WorkspaceState } from "../../lib/workspaceReducer";

/**
 * Read planStatesBySessionId truthiness to decide plan-mode visibility.
 *
 * `workspaces` is passed in as a prop instead of calling useWorkspaces here
 * — calling it inside this component would create a separate React state
 * instance (the dual-reducer bug; see the same note in useTaskSnapshot).
 */
export function PlanModeIndicator({
    cwd,
    sid,
    workspaces,
}: {
    cwd: WorkspaceId;
    sid: string;
    workspaces: Record<string, WorkspaceState>;
}) {
    const { t } = useT();
    const ps = workspaces[cwd]?.planStatesBySessionId[sid];
    if (!ps?.active) return null;
    return (
        // <output> carries role="status"; pairing with aria-live="polite" makes the
        // plan-mode entry/exit announcement automatic for screen readers (same
        // pattern as ContextIndicator). The dot is purely decorative, so it's
        // marked aria-hidden to avoid being read aloud.
        <output className="plan-mode-indicator" aria-live="polite" title={t("plan.modeTooltip")}>
            <span className="plan-mode-dot" aria-hidden="true" />
            Plan mode · {ps.currentSlug}
        </output>
    );
}
