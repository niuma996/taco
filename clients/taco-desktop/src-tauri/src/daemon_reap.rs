//! Reap an unusable sidecar daemon before the desktop starts a replacement.
//!
//! A daemon is a singleton for its runtime directory. A matching install id
//! plus a successful control ping and an existing NDJSON socket means the
//! daemon is healthy and must be reused, even when it was started by another
//! Tauri process or by a short-lived CLI launcher. This is important in debug
//! mode because `tsx taco.cjs start` exits after detaching the real daemon, so
//! the launcher pid is not the daemon pid.
//!
//! Only daemons that fail the health probe are reaped. A foreign install id is
//! always left untouched, because another Taco installation may actively use
//! the shared `$TACO_HOME`.
//!
//! # The ghost-socket case
//!
//! macOS Unix domain sockets can leave a live process with no usable socket
//! entry after an unclean shutdown. An alive pid with no NDJSON socket entry
//! is treated as stale and reaped.

#[cfg(unix)]
use std::io::Read;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Command;
#[cfg(unix)]
use std::time::{Duration, Instant};

#[cfg(unix)]
use sha2::{Digest, Sha256};

/// Compute the install id — MUST match `packages/sidecar/src/lib/installId.ts::computeInstallId`
/// and `packages/cli/lib/installId.ts::computeInstallId` byte-for-byte. The unit
/// test in `tests/daemon_reap.rs` enforces a fixed golden vector; if this
/// drifts from the TypeScript implementation, the desktop reap path will
/// silently skip its own daemon (or kill a sibling's).
#[cfg(unix)]
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
/// `packages/sidecar/src/lib/installId.ts`. Only Unix builds parse this;
/// Windows builds are gated by `#[cfg(unix)]` and never look at the file.
#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PidRecord {
    pub pid: u32,
    pub install_id: Option<String>,
    pub started_at: Option<String>,
}

/// Parse the pid file. Accepts the JSON record first, falls back to bare-int
/// for pre-PR-A daemons. Returns `None` for absent/malformed/unknown-schema
/// content so callers can treat the file as "no claim" and move on.
#[cfg(unix)]
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
        match json_field_u64(trimmed, "version") {
            Some(1) => {}
            _ => return None,
        }
        return Some(PidRecord {
            pid,
            install_id,
            started_at,
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
    })
}

#[cfg(unix)]
fn json_field_str<'a>(raw: &'a str, key: &str) -> Option<String> {
    let needle = format!("\"{}\":\"", key);
    let start = raw.find(&needle)? + needle.len();
    let rest = &raw[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_owned())
}

#[cfg(unix)]
fn json_field_u32(raw: &str, key: &str) -> Option<u32> {
    let needle = format!("\"{}\":", key);
    let start = raw.find(&needle)? + needle.len();
    let rest = raw[start..].trim_start();
    let end = rest
        .find(|c: char| c == ',' || c == '}' || c.is_whitespace())
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

#[cfg(unix)]
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
#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReapOutcome {
    /// No pid file existed. Nothing to do.
    NoPidFile,
    /// Pid file existed but didn't parse. Caller may want to log + unlink.
    Unparseable,
    /// Pid file's install_id didn't match ours. Foreign daemon — leave it alone.
    ForeignInstall,
    /// `control.ping` answered with the expected pid + matching install_id.
    /// The daemon is alive and serving this runtime — no reap needed. The
    /// desktop may have spawned a short-lived launcher (for example `tsx
    /// taco.cjs start`) whose pid is intentionally different from the daemon.
    Alive { pid: u32, uptime_s: u64 },
    /// Daemon was alive but did not answer the health probe. We killed it
    /// (SIGTERM → grace → SIGKILL) and unlinked pid + sockets so a fresh bind
    /// succeeds.
    Reaped { pid: u32, last_signal: &'static str, preserved_own: bool },
    /// Pid file pointed at a process that was already dead, OR alive but
    /// ghost-socket (no fs entry). We unlinked pid + sockets so a fresh
    /// bind succeeds.
    Stale { pid: u32, last_signal: &'static str },
}

/// Inputs the desktop knows about that the reap function needs.
#[cfg(unix)]
pub struct ReapInputs<'a> {
    /// Path to the pid file (typically `$TACO_HOME/run/sidecar.pid`).
    pub pid_file: PathBuf,
    /// NDJSON socket path -- unlinked after a successful reap.
    pub socket_path: PathBuf,
    /// Control socket path -- unlinked after a successful reap.
    pub control_socket_path: PathBuf,
    /// Computed install id for THIS desktop install.
    pub own_install_id: &'a str,
    /// Resources root shipped with THIS desktop install (used only as a
    /// diagnostic breadcrumb in error messages; the id comparison is the
    /// source of truth).
    pub resources_root: PathBuf,
}

/// Reap the previous daemon if one is stale.
///
/// `owned_pid` is retained for source compatibility with older callers, but
/// it must not be used as a daemon ownership test. In debug mode the desktop
/// launches `tsx taco.cjs start`; that launcher exits after detaching the real
/// daemon, so its pid is different from the pid in `sidecar.pid`. A healthy
/// daemon matching this runtime's install id is safe to reuse regardless of
/// which process launched it.
#[cfg(unix)]
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
    // A healthy daemon is the singleton for this runtime, even if it was
    // started by a previous desktop process or by a detached CLI launcher.
    // Reusing it is both safe and required for debug mode, where the launcher
    // pid is not the daemon pid.
    //
    // The pid file is written only after both sockets are bound, so require the
    // NDJSON entry as well as a successful control ping before declaring the
    // daemon healthy. This prevents a control-only half-start from being
    // mistaken for a reusable desktop connection.
    //
    // A daemon mid-initialization (channel stack, router load) or serving a
    // burst of connections can miss a single 500ms ping — its control replies
    // are scheduled on the same event loop. A false "unhealthy" here SIGKILLs
    // a healthy daemon and turns a slow boot into a kill/restart loop, so
    // retry the ping before declaring the daemon wedged.
    let mut pong = None;
    for attempt in 0..3 {
        if let Some(p) =
            ping_control_socket(inputs.control_socket_path.as_path(), Duration::from_millis(500))
        {
            pong = Some(p);
            break;
        }
        if attempt < 2 {
            std::thread::sleep(Duration::from_millis(300));
        }
    }
    if let Some(p) = pong {
        if p.pid == parsed.pid && inputs.socket_path.exists() {
            return ReapOutcome::Alive {
                pid: parsed.pid,
                uptime_s: p.uptime_s,
            };
        }
    }
    // Detect ghost socket: pid alive but fs entry missing. macOS lets
    // the inode survive via fd after unlink, so a connect() from a new
    // process fails with ENOENT even though pid_alive returns true. We
    // treat this as stale: kill the daemon, unlink, let the next spawn
    // re-bind.
    let pid_is_alive = pid_alive(parsed.pid);
    let ghost = pid_is_alive && !inputs.socket_path.exists();
    if !pid_is_alive || ghost {
        if ghost {
            eprintln!(
                "taco-desktop: ghost socket for pid={} (alive but {} has no fs entry); killing",
                parsed.pid,
                inputs.socket_path.display()
            );
        }
        // Stale pid file (or ghost): unlink everything, no SIGTERM needed.
        unlink_pid_and_sockets(inputs);
        return ReapOutcome::Stale {
            pid: parsed.pid,
            last_signal: if ghost { "ghost-socket" } else { "stale-pidfile" },
        };
    }
    // Pid alive + matches install, but the daemon did not pass the health
    // probe. Kill it so the next spawn can bind.
    let _ = Command::new("kill")
        .args(["-TERM", &parsed.pid.to_string()])
        .status();
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && pid_alive(parsed.pid) {
        std::thread::sleep(Duration::from_millis(100));
    }
    let last_signal = if pid_alive(parsed.pid) {
        let _ = Command::new("kill")
            .args(["-KILL", &parsed.pid.to_string()])
            .status();
        std::thread::sleep(Duration::from_millis(100));
        "SIGKILL"
    } else {
        "SIGTERM"
    };
    unlink_pid_and_sockets(inputs);
    ReapOutcome::Reaped {
        pid: parsed.pid,
        last_signal,
        preserved_own: false,
    }
}

/// Force reap variant used by `ensure_daemon_installed`. Same as
/// `reap_previous_daemon` but with `owned_pid = None` forced, AND with a
/// second pass that runs even after a "preserve alive own daemon" outcome:
/// the install flow is about to overwrite the wrapper script and reload
/// launchd, so any daemon (even ours) would be terminated by launchd's
/// reload anyway. Killing it pre-emptively gives a clean baseline.
#[cfg(unix)]
pub fn force_reap(inputs: &ReapInputs<'_>) -> ReapOutcome {
    let outcome = reap_previous_daemon(inputs, None);
    // If reap returned Alive (we'd preserved our own), kill it anyway --
    // install is about to bounce launchd. The daemon's parent plist will
    // respawn it; killing the current one means no double-instance during
    // the install handoff.
    if let ReapOutcome::Alive { pid, .. } = outcome {
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
        }
        unlink_pid_and_sockets(inputs);
        return ReapOutcome::Reaped {
            pid,
            last_signal: "force",
            preserved_own: false,
        };
    }
    outcome
}

#[cfg(unix)]
fn unlink_pid_and_sockets(inputs: &ReapInputs<'_>) {
    let _ = std::fs::remove_file(inputs.pid_file.as_path());
    let _ = std::fs::remove_file(inputs.socket_path.as_path());
    let _ = std::fs::remove_file(inputs.control_socket_path.as_path());
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    let status = Command::new("kill").args(["-0", &pid.to_string()]).status();
    match status {
        Ok(s) => s.success() || s.signal().is_some(),
        Err(_) => false,
    }
}

/// Tiny TCP/Unix-socket ping of the daemon's control channel. We don't
/// speak the full JSON-RPC protocol here -- a successful "connect + write
/// newline + read a non-empty byte" is enough to know the daemon is up.
#[cfg(unix)]
pub struct Pong {
    pid: u32,
    uptime_s: u64,
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
    let pid = json_field_u32(text, "pid")?;
    let uptime_s = json_field_u64(text, "uptime_s").unwrap_or(0);
    Some(Pong { pid, uptime_s })
}

/// Resolve the canonical pid/socket paths inside an explicit daemon runtime directory.
#[cfg(unix)]
pub fn daemon_runtime_paths(runtime_dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    (
        runtime_dir.join("sidecar.pid"),
        runtime_dir.join("sidecar.sock"),
        runtime_dir.join("sidecar-ctl.sock"),
    )
}

// On Windows, the pid-file reap path doesn't exist. Keep API stubs.
#[cfg(not(unix))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReapOutcome {
    NoPidFile,
}

#[cfg(not(unix))]
pub fn reap_previous_daemon(_inputs: &ReapInputs<'_>, _owned_pid: Option<u32>) -> ReapOutcome {
    ReapOutcome::NoPidFile
}

#[cfg(not(unix))]
pub fn force_reap(_inputs: &ReapInputs<'_>) -> ReapOutcome {
    ReapOutcome::NoPidFile
}

/// Test-only re-exports. The integration test under `tests/daemon_reap.rs`
/// and `tests/daemon_reap_integration.rs` links against these via
/// `taco_desktop_lib::daemon_reap_test::*`. None of these symbols are
/// reachable from the public command surface.
#[doc(hidden)]
pub mod __test_only {
    pub use super::{
        compute_install_id, daemon_runtime_paths, force_reap, parse_pid_file,
        reap_previous_daemon, PidRecord, Pong, ReapInputs, ReapOutcome,
        ping_control_socket,
    };
}
