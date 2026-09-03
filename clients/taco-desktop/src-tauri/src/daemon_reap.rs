//! Reap an unusable sidecar daemon before the desktop starts a replacement.
//!
//! A daemon is a singleton for its runtime directory. A matching install id +
//! a successful control ping + a serving NDJSON socket + the sidecar version
//! this desktop would spawn means the daemon is healthy AND current — it must
//! be reused, even when it was started by another Tauri process or by a
//! short-lived CLI launcher. (Debug mode: `tsx taco.cjs start` exits after
//! detaching the real daemon, so the launcher pid ≠ daemon pid.)
//!
//! The version gate is what makes upgrades take effect: `control.ping`
//! reports the running daemon's `sidecar_version`, the caller passes the
//! version it would spawn (`expected_sidecar_version`), and a mismatch reaps
//! the old daemon instead of attaching to it forever. `None` opts the caller
//! out (liveness only) for environments where no expectation is resolvable.
//!
//! Foreign install ids are always left untouched — another Taco installation
//! may actively use the shared `$TACO_HOME`. macOS Unix domain sockets can
//! also leave a live process with no usable socket entry after an unclean
//! shutdown; that case is treated as stale and reaped.
//!
//! Policy (what to reap and when) is platform-neutral; only the primitives
//! are per-platform: `pid_alive`, `socket_entry_present`,
//! `ping_control_socket`, and `terminate_daemon` (SIGTERM/SIGKILL on unix,
//! control.shutdown + taskkill on Windows).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::io::Read;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

use sha2::{Digest, Sha256};

/// Compute the install id — MUST match `packages/sidecar/src/lib/installId.ts::computeInstallId`
/// and `packages/cli/lib/installId.ts::computeInstallId` byte-for-byte. The unit
/// test in `tests/daemon_reap.rs` enforces a fixed golden vector; if this
/// drifts from the TypeScript implementation, the desktop reap path will
/// silently skip its own daemon (or kill a sibling's).
pub fn compute_install_id(resources_root: &str, taco_home: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(resources_root.as_bytes());
    hasher.update(b"\0");
    hasher.update(taco_home.as_bytes());
    let digest = hasher.finalize();
    let hex = format!("{:x}", digest);
    hex.chars().take(16).collect()
}

/// Pid file shape — see `SidecarPidRecord` in
/// `packages/sidecar/src/lib/installId.ts`. Written by the daemon on every
/// platform (Windows included — the reap path below is its consumer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PidRecord {
    pub pid: u32,
    pub install_id: Option<String>,
    pub started_at: Option<String>,
    /// `sidecar_version` field; `None` for legacy bare-int files and records
    /// written by daemons that predate the field. A missing version never
    /// satisfies a `Some(_)` expectation, so pre-field daemons reap as stale.
    pub sidecar_version: Option<String>,
}

/// Parse the pid file. Accepts the JSON record first, falls back to bare-int
/// for pre-PR-A daemons. Returns `None` for absent/malformed/unknown-schema
/// content so callers can treat the file as "no claim" and move on.
pub fn parse_pid_file(contents: &str) -> Option<PidRecord> {
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('{') {
        let pid = json_field_u32(trimmed, "pid")?;
        if pid == 0 {
            return None;
        }
        let install_id = json_field_str(trimmed, "install_id");
        let started_at = json_field_str(trimmed, "started_at");
        let sidecar_version = json_field_str(trimmed, "sidecar_version");
        match json_field_u64(trimmed, "version") {
            Some(1) => {}
            _ => return None,
        }
        return Some(PidRecord {
            pid,
            install_id,
            started_at,
            sidecar_version,
        });
    }
    let pid: u32 = trimmed.parse().ok()?;
    if pid == 0 {
        return None;
    }
    Some(PidRecord {
        pid,
        install_id: None,
        started_at: None,
        sidecar_version: None,
    })
}

fn json_field_str(raw: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\":\"", key);
    let start = raw.find(&needle)? + needle.len();
    let rest = &raw[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_owned())
}

fn json_field_u32(raw: &str, key: &str) -> Option<u32> {
    let needle = format!("\"{}\":", key);
    let start = raw.find(&needle)? + needle.len();
    let rest = raw[start..].trim_start();
    let end = rest
        .find(|c: char| c == ',' || c == '}' || c.is_whitespace())
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

fn json_field_u64(raw: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{}\":", key);
    let start = raw.find(&needle)? + needle.len();
    let rest = raw[start..].trim_start();
    let end = rest
        .find(|c: char| c == ',' || c == '}' || c.is_whitespace())
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// Outcome of a single reap attempt. The variants give the caller enough
/// information to log meaningfully (e.g. "reaped foreign daemon" vs
/// "no pid file" vs "preserved own daemon").
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReapOutcome {
    /// No pid file existed. Nothing to do.
    NoPidFile,
    /// Pid file existed but didn't parse. Caller may want to log + unlink.
    Unparseable,
    /// Pid file's install_id didn't match ours. Foreign daemon — leave it alone.
    ForeignInstall,
    /// `control.ping` answered with the expected pid + matching install_id +
    /// the sidecar version this caller would spawn. The daemon is alive,
    /// serving this runtime, and running current code — no reap needed. The
    /// desktop may have spawned a short-lived launcher (for example `tsx
    /// taco.cjs start`) whose pid is intentionally different from the daemon.
    Alive { pid: u32, uptime_s: u64 },
    /// Daemon answered the health probe but reported a sidecar version other
    /// than the one this caller would spawn — the classic "upgraded but still
    /// attached to the old build" case. We killed it (graceful → forced) and
    /// unlinked pid + sockets so the fresh spawn binds.
    VersionMismatch {
        pid: u32,
        expected: String,
        /// Version the daemon reported; `None` when the pong carried no
        /// version field at all (pre-gate daemon).
        found: Option<String>,
    },
    /// Daemon was alive but did not answer the health probe. We killed it
    /// (graceful → forced) and unlinked pid + sockets so a fresh bind
    /// succeeds.
    Reaped { pid: u32, last_signal: &'static str, preserved_own: bool },
    /// Pid file pointed at a process that was already dead, OR alive but
    /// ghost-socket (no server). We unlinked pid + sockets so a fresh
    /// bind succeeds.
    Stale { pid: u32, last_signal: &'static str },
}

/// Inputs the desktop knows about that the reap function needs.
pub struct ReapInputs<'a> {
    /// Path to the pid file (typically `$TACO_HOME/run/sidecar.pid`).
    pub pid_file: PathBuf,
    /// NDJSON socket path (unix) or named pipe (Windows) — unlinked /
    /// proven-absent after a successful reap.
    pub socket_path: PathBuf,
    /// Control socket path (unix) or named pipe (Windows) — ping target and
    /// graceful-shutdown channel.
    pub control_socket_path: PathBuf,
    /// Computed install id for THIS desktop install.
    pub own_install_id: &'a str,
    /// Sidecar version this desktop would spawn (bundle manifest in release,
    /// repo package.json in debug). `Some` enables the freshness gate: a
    /// healthy daemon reporting anything else is reaped. `None` keeps the
    /// pre-gate liveness-only behavior for callers that can't resolve an
    /// expectation.
    pub expected_sidecar_version: Option<&'a str>,
    /// Resources root shipped with THIS desktop install (used only as a
    /// diagnostic breadcrumb in error messages; the id comparison is the
    /// source of truth).
    pub resources_root: PathBuf,
}

/// The freshness gate, isolated for unit tests. `expected = None` means the
/// caller couldn't resolve what it would spawn — keep the historical
/// liveness-only behavior rather than reaping blindly on every launch.
pub fn pong_version_current(found: Option<&str>, expected: Option<&str>) -> bool {
    match expected {
        Some(exp) => found == Some(exp),
        None => true,
    }
}

/// Reap the previous daemon if one is stale.
///
/// `owned_pid` is retained for source compatibility with older callers, but
/// it must not be used as a daemon ownership test. In debug mode the desktop
/// launches `tsx taco.cjs start`; that launcher exits after detaching the real
/// daemon, so its pid is different from the pid in `sidecar.pid`. A healthy
/// daemon matching this runtime's install id is safe to reuse regardless of
/// which process launched it.
pub fn reap_previous_daemon(inputs: &ReapInputs<'_>, _owned_pid: Option<u32>) -> ReapOutcome {
    let raw = match std::fs::read_to_string(inputs.pid_file.as_path()) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ReapOutcome::NoPidFile,
        Err(_) => return ReapOutcome::Unparseable,
    };
    let parsed = match parse_pid_file(&raw) {
        Some(p) => p,
        None => return ReapOutcome::Unparseable,
    };
    // Foreign-install check. None (legacy bare-int) is allowed so old
    // pid files written before PR-A still get cleaned up.
    if let Some(ref id) = parsed.install_id {
        if id != inputs.own_install_id {
            return ReapOutcome::ForeignInstall;
        }
    }
    // A healthy daemon is the singleton for this runtime, even if started by a
    // previous desktop process or a detached CLI launcher — required in debug
    // mode where launcher pid ≠ daemon pid. The pid file is written only after
    // both sockets are bound, so require the NDJSON entry as well as a
    // successful control ping before declaring the daemon healthy (a
    // control-only half-start must not be mistaken for a reusable connection).
    //
    // A daemon mid-init or serving a burst can miss a single 120ms ping —
    // killing on a false "unhealthy" turns a slow boot into a kill/restart
    // loop, so retry the ping. Skip the retry budget when `pid_alive` says the
    // pid is already dead (signal-0, microseconds): the common case after a
    // desktop restart is exactly that, and the budget exists to ride out a
    // *live* daemon's GC pause — spending it on a dead pid is pure cold-start
    // latency. Schedule is escalating 120/240/480ms with 80ms gaps (≤1.0s
    // total) — a healthy daemon answers in single-digit ms.
    const PING_TIMEOUTS_MS: [u64; 3] = [120, 240, 480];
    let mut pong = None;
    if pid_alive(parsed.pid) {
        for (attempt, timeout_ms) in PING_TIMEOUTS_MS.iter().enumerate() {
            if let Some(p) = ping_control_socket(
                inputs.control_socket_path.as_path(),
                Duration::from_millis(*timeout_ms),
            ) {
                pong = Some(p);
                break;
            }
            if attempt + 1 < PING_TIMEOUTS_MS.len() {
                std::thread::sleep(Duration::from_millis(80));
            }
        }
    }
    if let Some(p) = pong {
        if p.pid == parsed.pid && socket_entry_present(inputs.socket_path.as_path()) {
            if pong_version_current(p.version.as_deref(), inputs.expected_sidecar_version) {
                return ReapOutcome::Alive {
                    pid: parsed.pid,
                    uptime_s: p.uptime_s,
                };
            }
            // Healthy but stale code. Reap it so the caller's spawn binds
            // the version it actually shipped.
            let _last = terminate_daemon(parsed.pid, inputs.control_socket_path.as_path());
            unlink_pid_and_sockets(inputs);
            return ReapOutcome::VersionMismatch {
                pid: parsed.pid,
                expected: inputs.expected_sidecar_version.unwrap_or("").to_owned(),
                found: p.version,
            };
        }
    }
    // Detect ghost socket: pid alive but no server behind the socket entry.
    // macOS lets the inode survive via fd after unlink, so a connect() from a
    // new process fails with ENOENT even though pid_alive returns true. We
    // treat this as stale: kill the daemon (graceful → forced), unlink pid +
    // sockets, let the next spawn re-bind. Without the kill, the live process
    // still owns the inode and the next spawn's bind() fails with EADDRINUSE —
    // the original ghost-socket symptom we set out to fix. Killing closes the
    // fd so the kernel reaps the inode and the follow-up unlink + new bind
    // succeed.
    let pid_is_alive = pid_alive(parsed.pid);
    let ghost = pid_is_alive && !socket_entry_present(inputs.socket_path.as_path());
    if !pid_is_alive || ghost {
        let last_signal = if pid_is_alive {
            eprintln!(
                "taco-desktop: ghost socket for pid={} (alive but {} has no listener); killing",
                parsed.pid,
                inputs.socket_path.display()
            );
            terminate_daemon(parsed.pid, inputs.control_socket_path.as_path())
        } else {
            "stale-pidfile"
        };
        unlink_pid_and_sockets(inputs);
        return ReapOutcome::Stale {
            pid: parsed.pid,
            last_signal,
        };
    }
    // Pid alive + matches install, but the daemon did not pass the health
    // probe. Kill it so the next spawn can bind.
    let last_signal = terminate_daemon(parsed.pid, inputs.control_socket_path.as_path());
    unlink_pid_and_sockets(inputs);
    ReapOutcome::Reaped {
        pid: parsed.pid,
        last_signal,
        preserved_own: false,
    }
}

/// Force-reap variant for the install path (`ensure_daemon_installed`).
/// Same as `reap_previous_daemon` but with `owned_pid = None` forced, AND
/// with a second pass that runs even after a "preserve alive own daemon"
/// outcome: install is about to overwrite the wrapper script and reload
/// launchd / schtasks, so any daemon — even our own, even one whose
/// control socket still answers — would be terminated by the service
/// reload anyway. Killing it pre-emptively gives a clean baseline and
/// avoids racing the launcher respawn into a double-bind on the same
/// socket inode.
pub fn force_reap(inputs: &ReapInputs<'_>) -> ReapOutcome {
    let outcome = reap_previous_daemon(inputs, None);
    // If reap returned Alive (we'd preserved our own), kill it anyway --
    // install is about to bounce the service. The service's parent config
    // will respawn it; killing the current one means no double-instance
    // during the install handoff. VersionMismatch/Reaped/Stale already
    // killed their daemon, so they pass straight through.
    if let ReapOutcome::Alive { pid, .. } = outcome {
        // Report the signal that actually landed, not a "force" literal:
        // last_signal is read by operators comparing reap logs across
        // platforms, and a vocabulary only this path emits made a forced
        // install-time reap indistinguishable from a graceful one.
        let last_signal = terminate_daemon(pid, inputs.control_socket_path.as_path());
        unlink_pid_and_sockets(inputs);
        return ReapOutcome::Reaped {
            pid,
            last_signal,
            preserved_own: false,
        };
    }
    outcome
}

fn unlink_pid_and_sockets(inputs: &ReapInputs<'_>) {
    let _ = std::fs::remove_file(inputs.pid_file.as_path());
    // Named pipes leave no filesystem entry; remove_file just fails and is
    // ignored, so this stays correct on Windows without a cfg branch.
    let _ = std::fs::remove_file(inputs.socket_path.as_path());
    let _ = std::fs::remove_file(inputs.control_socket_path.as_path());
}

/// Whether anything serves the NDJSON socket/pipe. Unix checks the fs entry
/// (ghost-socket detection); Windows named pipes have no fs entry, so we
/// attempt a connect — success proves a bound server.
#[cfg(unix)]
fn socket_entry_present(path: &Path) -> bool {
    path.exists()
}

#[cfg(windows)]
fn socket_entry_present(path: &Path) -> bool {
    std::fs::OpenOptions::new().read(true).open(path).is_ok()
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    let status = Command::new("kill").args(["-0", &pid.to_string()]).status();
    match status {
        Ok(s) => s.success() || s.signal().is_some(),
        Err(_) => false,
    }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    // tasklist is present on every supported Windows and needs no extra
    // crate. CSV output quotes every field, so `"4242"` is an unambiguous
    // match (no false positive on pids that merely contain the digits).
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")),
        Err(_) => false,
    }
}

/// Graceful-then-forced termination. Returns a short tag naming the signal
/// that landed, for the outcome's `last_signal` breadcrumb.
///
/// Unix: SIGTERM (the daemon's handler closes servers + unlinks) → 3s grace
/// → SIGKILL, which skips exit handlers so the caller unlinks instead.
///
/// Windows has no SIGTERM a console-less Node process can catch, so the
/// graceful step is the daemon's own `control.shutdown` RPC over the named
/// pipe — same exit path the CLI's `taco stop` exercises. `taskkill /F` is
/// the forced fallback.
#[cfg(unix)]
fn terminate_daemon(pid: u32, _control_socket_path: &Path) -> &'static str {
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && pid_alive(pid) {
        std::thread::sleep(Duration::from_millis(100));
    }
    if pid_alive(pid) {
        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status();
        std::thread::sleep(Duration::from_millis(100));
        "SIGKILL"
    } else {
        "SIGTERM"
    }
}

#[cfg(windows)]
fn terminate_daemon(pid: u32, control_socket_path: &Path) -> &'static str {
    use std::io::Write;
    // Best-effort graceful shutdown. A wedged daemon never reads the pipe;
    // the write just lands in the pipe buffer and we fall through to
    // taskkill after the grace window.
    if let Ok(mut pipe) = std::fs::OpenOptions::new()
        .write(true)
        .open(control_socket_path)
    {
        let _ = pipe.write_all(b"{\"method\":\"control.shutdown\",\"id\":1}\n");
        let _ = pipe.flush();
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && pid_alive(pid) {
        std::thread::sleep(Duration::from_millis(100));
    }
    if pid_alive(pid) {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status();
        std::thread::sleep(Duration::from_millis(100));
        "taskkill"
    } else {
        "control.shutdown"
    }
}

/// Tiny ping of the daemon's control channel. We don't speak the full
/// JSON-RPC protocol here -- a parseable reply carrying pid + uptime (and,
/// post-gate, the daemon's sidecar version) is enough to judge health.
/// Fields are pub for the `daemon_reap_test` surface; nothing outside reap
/// and its tests consumes them.
pub struct Pong {
    pub pid: u32,
    pub uptime_s: u64,
    pub version: Option<String>,
}

/// Parse one control-channel reply line into a Pong. Pub for the
/// `daemon_reap_test` surface; reap itself is the only real consumer.
pub fn parse_pong(text: &str) -> Option<Pong> {
    let pid = json_field_u32(text, "pid")?;
    let uptime_s = json_field_u64(text, "uptime_s").unwrap_or(0);
    let version = json_field_str(text, "version");
    Some(Pong {
        pid,
        uptime_s,
        version,
    })
}

#[cfg(unix)]
pub fn ping_control_socket(path: &Path, timeout: Duration) -> Option<Pong> {
    use std::io::Write;
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    let mut stream = UnixStream::connect(path).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    stream.write_all(b"{\"method\":\"control.ping\",\"id\":1}\n").ok()?;
    stream.flush().ok()?;
    let mut buf = [0u8; 512];
    let _ = stream.shutdown(Shutdown::Write);
    let n = match stream.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return None,
    };
    let text = std::str::from_utf8(&buf[..n]).ok()?;
    parse_pong(text)
}

#[cfg(windows)]
pub fn ping_control_socket(path: &Path, timeout: Duration) -> Option<Pong> {
    use std::io::{Read as _, Write};
    // std File reads have no timeout, so read on a worker thread and bound
    // the wait with a channel.
    //
    // On timeout the worker stays blocked in `read` — Rust cannot cancel a
    // thread, and the block is in `read`, not in `send`, so neither a
    // JoinHandle nor `send_timeout` can shorten it. It unblocks when the
    // pipe closes: either the daemon answers late, or the caller's
    // `terminate_daemon` kills it moments later (every timeout path here
    // leads to a terminate). Lifetime is therefore the daemon's, not the
    // reap's, and the count is bounded by the retry schedule (≤3 per reap).
    // Truly cancelling the read needs overlapped IO + `CancelIoEx` from
    // `windows-sys`; not worth a platform dependency for three threads that
    // exit on their own.
    let mut pipe = std::fs::OpenOptions::new().read(true).write(true).open(path).ok()?;
    pipe.write_all(b"{\"method\":\"control.ping\",\"id\":1}\n").ok()?;
    pipe.flush().ok()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 512];
        if let Ok(n) = pipe.read(&mut buf) {
            let _ = tx.send(buf[..n].to_vec());
        }
    });
    let data = rx.recv_timeout(timeout).ok()?;
    let text = std::str::from_utf8(&data).ok()?;
    parse_pong(text)
}

/// Resolve the canonical pid/socket paths inside an explicit daemon runtime
/// directory. On Windows the sockets are named pipes — `paths.rs` owns their
/// names, so this delegates rather than duplicating them.
#[cfg(unix)]
pub fn daemon_runtime_paths(runtime_dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    (
        runtime_dir.join("sidecar.pid"),
        runtime_dir.join("sidecar.sock"),
        runtime_dir.join("sidecar-ctl.sock"),
    )
}

#[cfg(windows)]
pub fn daemon_runtime_paths(runtime_dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    (
        runtime_dir.join("sidecar.pid"),
        crate::paths::ndjson_socket_path(runtime_dir),
        crate::paths::control_socket_path(runtime_dir),
    )
}

/// Test-only re-exports. The integration test under `tests/daemon_reap.rs`
/// and `tests/daemon_reap_integration.rs` links against these via
/// `taco_desktop_lib::daemon_reap_test::*`. None of these symbols are
/// reachable from the public command surface.
#[doc(hidden)]
pub mod __test_only {
    pub use super::{
        compute_install_id, daemon_runtime_paths, force_reap, parse_pid_file, parse_pong,
        ping_control_socket, pong_version_current, reap_previous_daemon, PidRecord, Pong,
        ReapInputs, ReapOutcome,
    };
}
