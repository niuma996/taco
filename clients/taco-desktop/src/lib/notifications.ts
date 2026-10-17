/**
 * Notification shape for the topbar bell — the list that replaced the old
 * full-width error banner.
 *
 * It lives here rather than in `useWorkspaces` so the presentational components
 * (`NotificationBell`, `TopbarQuickActions`) can type their props without
 * importing the big state hook. `useWorkspaces` owns the state; this file owns
 * the vocabulary — including the one policy both App and the bell must agree
 * on, `toastsOnArrival`.
 */

/**
 * Where a notification came from. Only the kinds a consumer needs to tell apart
 * are enumerated; everything else stays `generic`.
 *
 * `workspace-open` exists so the onboarding modal can render the one failure it
 * cares about ("this directory would not open") without latching onto whatever
 * unrelated message happens to be newest in the list.
 */
export type AppNotificationKind = "generic" | "workspace-open";

/**
 * `client` — the reply to something the user just did (sent a prompt, opened a
 * folder, saved memory). `sidecar` — arrived on the sidecar's own stream
 * (stderr log lines, `session.error` pushes, push-driven recovery), unprompted
 * by any click.
 */
export type AppNotificationSource = "client" | "sidecar";

/** `warn` rows are degradations (a skipped file, a rebuilt cache), not failures. */
export type AppNotificationLevel = "error" | "warn";

export interface ApprovalNotificationTarget {
    cwd: string;
    sessionId: string;
    requestId: string;
}

export interface AppNotification {
    approval?: ApprovalNotificationTarget;
    id: number;
    text: string;
    /** `Date.now()` at push time — the clock shown next to the row. */
    at: number;
    /**
     * How many times this text arrived inside the coalescing window. A chatty
     * sidecar re-emitting the same `[error]` line must not fill the list with
     * identical rows, so repeats merge into the head row and bump this instead.
     */
    count: number;
    kind: AppNotificationKind;
    source: AppNotificationSource;
    level: AppNotificationLevel;
}

export interface PushNotificationOptions {
    approval?: ApprovalNotificationTarget;
    kind?: AppNotificationKind;
    source?: AppNotificationSource;
    level?: AppNotificationLevel;
}

/**
 * Whether a newly arrived row also interrupts with a toast. Only replies to a
 * user action do — the user is waiting on that outcome. The sidecar's stream
 * lands in the bell silently, or a daemon retrying a dead channel would toast
 * on every tick.
 *
 * Shared because two places act on it: App fires the toast, and the bell skips
 * its own live-region announcement for these rows (the toast's `role="alert"`
 * already announces them — announcing twice is noise for screen readers).
 */
export function toastsOnArrival(n: AppNotification): boolean {
    return n.source === "client";
}
