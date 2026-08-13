/**
 * Plan-mode runtime state — kept alive for the workspace lifetime (in-memory;
 * not persisted to disk). Plan document storage paths are computed by
 * planPersistence.getPlansDir / getPlanPath.
 */
export interface PlanModeState {
    active: boolean;
    currentSlug: string | null;
}

export function createPlanModeState(): PlanModeState {
    return {
        active: false,
        currentSlug: null,
    };
}

export function enterPlanMode(state: PlanModeState, slug: string): void {
    state.active = true;
    state.currentSlug = slug;
}

export function exitPlanMode(state: PlanModeState): void {
    state.active = false;
    state.currentSlug = null;
}

export function isPlanModeActive(state: PlanModeState): boolean {
    return state.active;
}

export function getCurrentPlanSlug(state: PlanModeState): string | null {
    return state.currentSlug;
}
