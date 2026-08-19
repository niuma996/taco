//! Reap a stale sidecar daemon before the desktop starts a replacement.
//!
//! The pid-file lives at `$TACO_HOME/run/sidecar.pid` and is written by
//! the daemon itself after both sockets bind (see
//! `packages/sidecar/src/index.ts` `runDaemon`). Two on-disk formats are
//! accepted (mirroring `packages/cli/lib/installId.ts::parsePidFile`):
//!
//! - **JSON record** (current): `{"version": 1, "pid": <n>, "install_id": "<16hex>", "started_at": "<iso>"}`.
//!   The `install_id` lets us distinguish a daemon this desktop started
//!   from one started by a sibling taco install that happens to share
//!   `$TACO_HOME` (npm global + desktop bundle, dev repo + release, etc.).
//! - **Legacy bare-int** (pre-PR-A): a single decimal pid string. We
//!   reap these unconditionally — a pre-PR-A daemon is the only thing
//!   that could have written them, and the migration to the new format
//!   happens naturally on the next fresh spawn.
//!
//! The reap is **idempotent** — calling it when nothing is stale is a
//! no-op. It is also **Unix-only**: Windows uses the service control
//! manager and doesn't write a pid file. The reap gates every spawn path
//! (install, ensure, shutdown) so a previous daemon can never race the
//! new one for the control socket.

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
/// test in `tests/install_id_reap.rs` enforces a fixed golden vector; if this
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
        // Hand-rolled minimal JSON parser: we only ever see a flat object
        // with three string/number fields. Pulling in serde_json here would
        // double the binary's transitive JSON dependencies just for two
        // lines; the fields we need are simple enough to scan for.
        // (We DO already link serde_json for the Tauri command surface;
        //   using it here would actually be cleaner. Switch if more fields
        //   land in the schema.)
        let pid = json_field_u32(trimmed, "pid")?;
        if pid == 0 {
            return None;
        }
        let install_id = json_field_str(trimmed, "install_id");
        let started_at = json_field_str(trimmed, "started_at");
        // Schema gate: if the file claims version != 1 we bail rather than
        // act on a record whose shape we don't recognise.
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
/// "no pid file").
#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReapOutcome {
    /// No pid file existed. Nothing to do.
    NoPidFile,
    /// Pid file existed but didn't parse. Caller may want to log + unlink.
    Unparseable,
    /// Pid file's install_id didn't match ours. Foreign daemon — leave it alone.
    ForeignInstall,
    /// `control.ping` answered with the expected pid+install. Daemon is
    /// alive and serving — no reap needed.
    Alive { pid: u32, uptime_s: u64 },
    /// Daemon was alive at the pid-file path but didn't respond to a ping,
    /// OR its reported pid didn't match the pid file (PID recycle).
    /// We sent SIGTERM → SIGKILL and unlinked pid+sockets.
    Reaped { pid: u32, last_signal: &'static str },
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
    #[allow(dead_code)]
    pub resources_root: PathBuf,
}

/// Reap the previous daemon if one is stale. Idempotent.
#[cfg(unix)]
pub fn reap_previous_daemon(inputs: &ReapInputs<'_>) -> ReapOutcome {
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
    // Try control.ping first — daemon might be alive and serving, in
    // which case we leave it alone entirely (re-spawning would race for
    // the control socket). The ping body returns {pid, uptime_s, ...};
    // we accept any pid that matches the pid file (PID recycle check).
    match ping_control_socket(inputs.control_socket_path.as_path(), Duration::from_millis(500)) {
        Some(pong) if pong.pid == parsed.pid => {
            return ReapOutcome::Alive {
                pid: parsed.pid,
                uptime_s: pong.uptime_s,
            };
        }
        _ => {}
    }
    // Process liveness probe (kill -0). If the pid file's pid isn't
    // alive, the file is stale — unlink and we're done.
    if !pid_alive(parsed.pid) {
        let _ = std::fs::remove_file(inputs.pid_file.as_path());
        let _ = std::fs::remove_file(inputs.socket_path.as_path());
        let _ = std::fs::remove_file(inputs.control_socket_path.as_path());
        return ReapOutcome::Reaped {
            pid: parsed.pid,
            last_signal: "stale-pidfile",
        };
    }
    // Send SIGTERM, then SIGKILL after the grace window if needed.
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
        // Give the kernel a beat to actually reap so we don't unlink
        // files out from under a process still in the middle of dying.
        std::thread::sleep(Duration::from_millis(100));
        "SIGKILL"
    } else {
        "SIGTERM"
    };
    let _ = std::fs::remove_file(inputs.pid_file.as_path());
    let _ = std::fs::remove_file(inputs.socket_path.as_path());
    let _ = std::fs::remove_file(inputs.control_socket_path.as_path());
    ReapOutcome::Reaped {
        pid: parsed.pid,
        last_signal,
    }
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    let status = Command::new("kill").args(["-0", &pid.to_string()]).status();
    match status {
        Ok(s) => s.success() || s.signal().is_some(),
        // If kill(1) itself can't run, fall back to assuming dead — the
        // reap will then unlink stale files which is the safe default.
        Err(_) => false,
    }
}

/// Tiny TCP/Unix-socket ping of the daemon's control channel. We don't
/// speak the full JSON-RPC protocol here — a successful "connect + write
/// newline + read a non-empty byte" is enough to know the daemon is up.
/// If the caller needs a richer handshake (e.g. matching `protocol`
/// version) they can extend this. The desktop's existing
/// `control_socket_present` already does the lighter probe so this is
/// only used by the reap path.
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
    // Minimal control.ping — daemon returns a JSON line containing pid + uptime_s.
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

/// Resolve the canonical pid/socket paths under `$TACO_HOME/run/`. Mirrors
/// `packages/cli/lib/paths.ts` so the Rust side doesn't have to repeat
/// the join math at every call site.
#[cfg(unix)]
pub fn daemon_paths(home: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let run = home.join("run");
    (
        run.join("sidecar.pid"),
        run.join("sidecar.sock"),
        run.join("sidecar-ctl.sock"),
    )
}

// On Windows, the pid-file reap path doesn't exist — the service control
// manager owns the daemon's lifecycle and the desktop defers to it via
// `control.shutdown`. The stub keeps the API surface uniform so callers
// can write one `#[cfg(unix)] { reap } #[cfg(not(unix)) { skip }` branch
// instead of duplicating the call-site logic.
#[cfg(not(unix))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReapOutcome {
    NoPidFile,
}

#[cfg(not(unix))]
pub fn reap_previous_daemon(_inputs: &()) -> ReapOutcome {
    ReapOutcome::NoPidFile
}

/// Test-only re-exports. The integration test under `tests/daemon_reap.rs`
/// links against these via `taco_desktop_lib::__test_only::*`. None of these
/// symbols are reachable from the public command surface.
#[cfg(unix)]
#[doc(hidden)]
pub mod __test_only {
    pub use super::{
        compute_install_id, daemon_paths, parse_pid_file, PidRecord, Pong, ReapInputs,
        ReapOutcome, ping_control_socket, reap_previous_daemon,
    };
}
