/**
 * Skill hot reload — watches the skill directories, debounces the fs-event
 * burst, and runs the injected rescan through a SingleFlight so concurrent
 * bursts (and an explicit reload racing a debounced one) collapse into one
 * in-flight scan.
 *
 * Split out of `WorkspaceRuntime` because it owns a real lifecycle — chokidar
 * handle, debounce timer, in-flight scan — that nothing else in the workspace
 * touches. The workspace only declares which dirs to watch and decides what
 * "apply the scan" means.
 */

import { existsSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import type { SkillDiagnosticEntry } from "@taco-ai/protocol";
import { type FSWatcher, watch as watchFs } from "chokidar";
import { SingleFlight } from "../lib/async.ts";
import { createLogger } from "../lib/logger.ts";
import type { SkillScanResult, TacoSkill } from "../skills/tacoSkill.ts";

const log = createLogger("workspace.skillHotReload");

/**
 * How long to wait after the last skill-directory fs event before rescanning.
 * One `SKILL.md` save is normally several events in quick succession (write +
 * rename + parent-dir touch), and an editor's atomic-save dance can add more,
 * so the timer is reset on every event and only the trailing one reloads.
 */
const SKILL_RELOAD_DEBOUNCE_MS = 300;

export interface SkillHotReloadOptions {
    /** Directories to watch; empty or absent disables the watcher entirely. */
    readonly skillDirs?: readonly string[];
    /**
     * Rescan callback injected by `SidecarServer`. Absent in direct-construction
     * tests, where reloads are deliberately a no-op.
     */
    readonly reloadSkills?: () => Promise<SkillScanResult>;
    /** Diagnostics produced by the cold-start scan. */
    readonly initialDiagnostics?: readonly SkillDiagnosticEntry[];
    /** Apply a completed scan; the workspace owns what "applied" means. */
    readonly applyScan: (skills: TacoSkill[]) => void;
}

export class SkillHotReloader {
    /** Replaced wholesale on every scan: these describe the current on-disk
     *  state, not a running history. */
    private diagnostics: readonly SkillDiagnosticEntry[];
    private readonly applyScan: SkillHotReloadOptions["applyScan"];
    /** Built only when a scanner was injected, so its factory never faces an
     *  absent callback — the gate and the flight are the same field. */
    private readonly flight?: SingleFlight<"skills", SkillScanResult>;
    private watcher?: FSWatcher;
    private debounce?: NodeJS.Timeout;
    /** Resolves once chokidar has completed its initial scan; undefined when no
     *  watcher was created. Tests await this before creating a file; production
     *  need not, because events before readiness are covered by the cold-start
     *  scan. */
    readonly ready?: Promise<void>;

    constructor(options: SkillHotReloadOptions) {
        this.diagnostics = options.initialDiagnostics ?? [];
        this.applyScan = options.applyScan;
        // Only set up a scan flight (and a watcher) when a scanner is given.
        // `SidecarServer.buildWorkspace` always passes both, but direct
        // construction (unit tests, and any future non-fs caller) getting
        // neither is the correct default: no watcher, no dependency on
        // chokidar's filesystem semantics.
        const reload = options.reloadSkills;
        if (reload) {
            this.flight = new SingleFlight<"skills", SkillScanResult>(() => reload());
            if (options.skillDirs && options.skillDirs.length > 0) {
                const { watcher, ready } = this.startWatcher(options.skillDirs);
                this.watcher = watcher;
                this.ready = ready;
            }
        }
    }

    /** Current on-disk diagnostics; replaced on every completed scan. */
    currentDiagnostics(): readonly SkillDiagnosticEntry[] {
        return this.diagnostics;
    }

    /** Re-scan and apply. No-op when no scan callback was injected. */
    async reloadNow(): Promise<void> {
        const flight = this.flight;
        if (!flight) return;
        const { skills, diagnostics } = await flight.run("skills");
        this.diagnostics = diagnostics;
        this.applyScan(skills);
    }

    async dispose(): Promise<void> {
        if (this.debounce) clearTimeout(this.debounce);
        await this.watcher?.close();
    }

    private startWatcher(skillDirs: readonly string[]): {
        watcher: FSWatcher;
        ready: Promise<void>;
    } {
        // chokidar v4 watches the nearest *existing* ancestor of a missing
        // path and reports it once it appears — but only when some ancestor
        // exists. For a path whose whole parent chain is absent (the common
        // first-run case for `<cwd>/.taco/skills`, since `.taco/` itself is
        // only created lazily), chokidar watches nothing and never emits.
        // Verified against chokidar 4.0.3: `getWatched()` is `{}` and the
        // first `mkdir -p` + SKILL.md write produces zero events. So ensure
        // the taco-owned leaf exists first (`<cwd>/.taco/skills`,
        // `$TACO_HOME/skills`). mkdir is idempotent and these are taco's own
        // dirs; we deliberately do NOT watch an ancestor like `cwd`, because
        // that would fire a rescan on every unrelated file change in the
        // project. `~/.claude/skills` / `~/.pi/skills` belong to other tools
        // — never created here; for those the parent dir already exists, so
        // the nearest-ancestor fallback works.
        for (const dir of skillDirs) {
            if (!dir.includes("/.taco/")) continue;
            try {
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            } catch (e) {
                log.warn(
                    `could not create skill dir ${dir} for watching: ${e instanceof Error ? e.message : String(e)}`,
                );
            }
        }
        // Only SKILL.md matters for hot reload: skill metadata/instructions
        // live there, while every other file under a skill dir (helper
        // scripts, templates, images, node_modules…) is read lazily at
        // invocation time. The bundled sidecar has no fsevents, so chokidar
        // falls back to per-file fs.watch — watching whole dirs holds one fd
        // per file (measured: +778 fds for ~450 skill files). Filtering
        // non-SKILL.md files out of the watch drops that to ~148 (the
        // SKILL.md files plus the directories chokidar must keep watching to
        // discover newly added skills). Directories are never ignored here:
        // pruning one would hide a SKILL.md created inside it later.
        const watcher = watchFs([...skillDirs], {
            ignoreInitial: true,
            ignored: (path, stats) => Boolean(stats?.isFile()) && basename(path) !== "SKILL.md",
        });
        const ready = new Promise<void>((resolve) => {
            watcher.once("ready", () => resolve());
        });
        watcher.on("all", () => {
            // One timer field, reset on every event — see
            // SKILL_RELOAD_DEBOUNCE_MS for why only the trailing event in
            // a burst should reload.
            if (this.debounce) clearTimeout(this.debounce);
            this.debounce = setTimeout(() => {
                this.reloadNow().catch((e) => {
                    log.warn(
                        `skill hot reload failed: ${e instanceof Error ? e.message : String(e)}`,
                    );
                });
            }, SKILL_RELOAD_DEBOUNCE_MS);
        });
        watcher.on("error", (e) => {
            log.warn(`skill watcher error: ${e instanceof Error ? e.message : String(e)}`);
        });
        return { watcher, ready };
    }
}
