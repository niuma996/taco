//! Boot-phase timing trace — answers "where did cold start spend its time?".
//!
//! Cold-start stalls have repeatedly been misdiagnosed because post-hoc
//! starts *after* the slow part is already over. Rust's `eprintln!` markers
//! only reach `pnpm tauri:dev`'s terminal and are gone once it scrolls, and the
//! webview's console never lands on disk at all. This module writes a single
//! append-only file that both sides share, so a slow boot can be diagnosed
//! from artifacts instead of from a live reproduction.
//!
//! Design constraints, in priority order:
//!
//! 1. **Never block or panic the caller.** Every entry point swallows its own
//!    errors. A boot trace that can stall boot would be worse than no trace.
//! 2. **Monotonic offsets, not wall-clock deltas.** All offsets are measured
//!    from `PROCESS_START` (first touch of this module, which `run()` forces
//!    early in `main`) via `Instant`, so a mid-boot system clock adjustment
//!    cannot produce negative or inflated spans. The absolute wall-clock time
//!    is recorded once per line for correlation with `daemon.err.log`.
//! 3. **One line per event, greppable.** Format is
//!    `<rfc3339> +<offset_ms>ms [<source>] <label><detail>`.
//!
//! The file lives at `<TACO_HOME>/logs/boot.log` — the same directory the
//! daemon tees its stderr into, and deliberately keyed off `TACO_HOME` (shared)
//! rather than the runtime dir (isolated per dev/prod), so a dev boot and a
//! release boot land in one timeline.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::log_file::LogFile;

/// Process start reference for every offset this module reports. Initialized on
/// first touch; `init()` forces that to happen at the top of `run()` so the
/// zero point is "process entered main", not "something first logged".
static PROCESS_START: OnceLock<Instant> = OnceLock::new();

/// The open log file. `None` until `init()` resolves a writable path; entries
/// logged before that are dropped rather than buffered — pre-init callers are
/// by definition earlier than we can resolve `TACO_HOME`, and silently losing
/// them beats holding boot on a directory create.
static SINK: OnceLock<Option<Mutex<LogFile>>> = OnceLock::new();

fn process_start() -> Instant {
    *PROCESS_START.get_or_init(Instant::now)
}

/// Milliseconds since process start. Saturates rather than wrapping.
fn offset_ms() -> u128 {
    process_start().elapsed().as_millis()
}

/// Best-effort RFC3339-ish UTC stamp without pulling in `chrono`. Only used for
/// correlating with other logs, so second precision plus the millisecond offset
/// on the same line is enough.
fn wall_clock() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Civil-time conversion from a Unix timestamp (days-since-epoch algorithm,
    // Howard Hinnant's `civil_from_days`). Avoids a date dependency for what is
    // ultimately a correlation aid.
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, h, mi, s
    )
}

/// Resolve `<TACO_HOME>/logs/boot.log`, creating the directory if needed.
///
/// Deliberately does NOT take an `AppHandle`: `init()` is called from the very
/// top of `run()`, before the Tauri app exists, precisely so that the earliest
/// phases are traceable. That means replicating the `TACO_HOME` env/default
/// resolution rather than reusing `resolve_taco_home(app)`; the fallback
/// (`~/.taco`) matches `paths::default_taco_home`.
fn resolve_log_path() -> Option<PathBuf> {
    let taco_home = match std::env::var("TACO_HOME") {
        Ok(raw) if !raw.trim().is_empty() => {
            let p = PathBuf::from(raw.trim());
            if p.is_absolute() {
                p
            } else {
                std::env::current_dir().ok()?.join(p)
            }
        }
        _ => {
            #[allow(deprecated)]
            let home = std::env::home_dir()?;
            home.join(".taco")
        }
    };
    let logs = taco_home.join("logs");
    std::fs::create_dir_all(&logs).ok()?;
    Some(logs.join("boot.log"))
}

/// Open the sink and stamp the process-start zero point. Idempotent; safe to
/// call more than once (subsequent calls are no-ops). Call as the first
/// statement in `run()` so every later offset shares one origin.
pub fn init() {
    let _ = process_start();
    SINK.get_or_init(|| {
        let path = resolve_log_path()?;
        let mut file = LogFile::open(path).ok()?;
        // Separator so consecutive boots are visually distinct in one file.
        let _ = file.write_line("");
        let _ = file.write_line(&format!(
            "=== boot {} pid={} debug={} ===",
            wall_clock(),
            std::process::id(),
            cfg!(debug_assertions)
        ));
        let _ = file.flush();
        Some(Mutex::new(file))
    });
}

/// Record one boot event. `source` distinguishes the emitter (`"rust"` /
/// `"ui"`); `detail` is appended verbatim when non-empty.
///
/// Flushes on every line: a boot that hangs (the exact case this exists for)
/// would otherwise lose the buffered tail naming the phase that hung.
pub fn mark(source: &str, label: &str, detail: &str) {
    let line = if detail.is_empty() {
        format!("{} +{}ms [{}] {}", wall_clock(), offset_ms(), source, label)
    } else {
        format!(
            "{} +{}ms [{}] {} {}",
            wall_clock(),
            offset_ms(),
            source,
            label,
            detail
        )
    };
    // Mirror to stderr so `pnpm tauri:dev` users see the timeline live.
    eprintln!("taco-boot: {}", line);
    if let Some(Some(sink)) = SINK.get() {
        // A poisoned mutex means an earlier writer panicked mid-line. Recover
        // the guard rather than propagating: a torn trace line is strictly
        // better than taking down boot over telemetry.
        let mut guard = match sink.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let _ = guard.write_line(&line);
        let _ = guard.flush();
    }
}

/// Convenience for the common "label only" case.
pub fn mark_rust(label: &str) {
    mark("rust", label, "");
}

/// Convenience for "label + detail" from Rust.
pub fn mark_rust_detail(label: &str, detail: &str) {
    mark("rust", label, detail);
}

/// Scope guard that reports how long a phase took on drop, including when the
/// phase exits early via `?`. `mark_rust(<label>.start)` fires on construction.
pub struct Phase {
    label: String,
    started: Instant,
}

impl Phase {
    pub fn new(label: &str) -> Self {
        mark_rust(&format!("{}.start", label));
        Self {
            label: label.to_owned(),
            started: Instant::now(),
        }
    }
}

impl Drop for Phase {
    fn drop(&mut self) {
        mark_rust_detail(
            &format!("{}.done", self.label),
            &format!("took={}ms", self.started.elapsed().as_millis()),
        );
    }
}
