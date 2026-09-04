/*!
 * Tauri 2 entry — spawn sidecar + expose invoke commands to the React side.
 *
 * One sidecar subprocess per process. Rust only owns the process lifecycle
 * and the stdio byte pipes; the sidecar itself routes by `params.workspace`
 * and lazy-builds WorkspaceRuntime, so multiple workspaces don't need
 * multiple processes. Rust does NOT parse protocol frames — stdout lines
 * are forwarded verbatim as the Tauri event `sidecar-event {line}`, and the
 * frontend dispatcher decides which workspace the frame belongs to from
 * its fields.
 */

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_fs::FsExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};

pub mod log_file;
pub use log_file::LogFiles;

pub mod boot_trace;
mod daemon_reap;
mod paths;
mod sidecar_launcher;
/// Test-only re-exports for the daemon_reap integration test under
/// `tests/daemon_reap.rs`. Hidden from the public docs because the
/// symbols are crate-internal helpers, not a stable API.
#[cfg(unix)]
#[doc(hidden)]
pub mod daemon_reap_test {
    pub use crate::daemon_reap::__test_only::*;
}
pub mod upgrade_commands;

use crate::paths::{
    control_socket_path, find_repo_root, normalize_cwd, resolve_taco_home, resolve_taco_runtime_dir,
    strip_win_verbatim,
};
#[cfg(debug_assertions)]
use crate::sidecar_launcher::DEBUG_ONLY_PASSTHROUGH_ENV;
use crate::sidecar_launcher::{resolve_install_launcher, resolve_sidecar, PASSTHROUGH_ENV};

/// Gate that lets a programmatic `AppHandle::exit` pass through without
/// re-entering the shutdown helper. The OS-driven `RunEvent::ExitRequested`
/// (Cmd+Q / window manager close on Windows/Linux) calls `prevent_exit`,
/// runs the sidecar teardown, then `exit(0)` triggers a second ExitRequested.
/// Swapping the gate from false → true on the first event marks the second
/// one as "already handled" so it falls through and the process actually
/// terminates.
static EXIT_GATE: AtomicBool = AtomicBool::new(false);

/// Absolute path of the default workspace, with the directory guaranteed to exist.
///
/// Previously hardcoded to `/tmp/taco-demo`, but macOS periodically cleans `/tmp` and that
/// path was never created — a fresh install pointed at a non-existent directory. The sidecar
/// uses it as the stdio MCP server's default cwd, so spawn would fail with "command ENOENT"
/// and the error pointed nowhere useful. Putting it under TACO_HOME and mkdir'ing here fixes
/// both problems at once.
#[tauri::command]
async fn default_workspace_dir(app: AppHandle) -> Result<String, String> {
    let dir = resolve_taco_home(&app)?.join("workspace");
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("failed to create default workspace dir: {e}"))?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// Batch-check whether each path is an existing directory, returning results in input order.
///
/// The frontend uses this to prune stale workspace entries (moved / deleted dirs, `/tmp`
/// cleanups). Done in Rust rather than the frontend fs plugin because the checked paths
/// are outside the fs scope — the plugin would reject them, and we only read metadata.
///
/// macOS TCC: when permission is undecided, stat under `~/Documents` returns EPERM rather
/// than success — `is_dir()` would treat that as "directory does not exist" and prune a
/// real workspace. PermissionDenied is therefore treated as "exists": keeping one stale
/// entry is better than dropping a workspace whose TCC prompt hasn't been answered yet.
#[tauri::command]
async fn paths_are_dirs(paths: Vec<String>) -> Result<Vec<bool>, String> {
    Ok(paths
        .into_iter()
        .map(|p| {
            match std::fs::metadata(&p) {
                Ok(m) => m.is_dir(),
                // PermissionDenied covers EACCES (unix) and ERROR_ACCESS_DENIED
                // (windows) — both mean "there but not yours to see".
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => true,
                Err(_) => false,
            }
        })
        .collect())
}

/// Read `debugMode` from `~/.taco/desktop.json`. Returns false on any
/// failure path (missing file, parse error, non-bool value) — safe default.
/// Sidecar spawn-time env injection is driven by this so the Debug tab's
/// toggle takes effect on every subsequent spawn, including the cold-start
/// `prewarm_daemon` (which runs before the WebView exists and so cannot
/// read localStorage).
fn read_desktop_config_debug_mode(app: &tauri::AppHandle) -> bool {
    let path = match resolve_taco_home(app) {
        Ok(p) => p.join("desktop.json"),
        Err(_) => return false,
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return false,
    };
    parsed.get("debugMode").and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Read `llmDumpToFile` from `~/.taco/desktop.json`. Same failure-path
/// contract as `read_desktop_config_debug_mode`. Drives the stderr
/// reader's disk-tee filter; not injected as sidecar env because the
/// sidecar is unaware of the toggle — it keeps writing `[taco:llm]`
/// lines whenever `debugMode` is on, and Rust decides whether to mirror
/// them to `$TACO_HOME/logs/llm-dump.log`.
fn read_desktop_config_llm_dump_to_file(app: &tauri::AppHandle) -> bool {
    let path = match resolve_taco_home(app) {
        Ok(p) => p.join("desktop.json"),
        Err(_) => return false,
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return false,
    };
    parsed.get("llmDumpToFile").and_then(|v| v.as_bool()).unwrap_or(false)
}

#[tauri::command]
async fn desktop_config_read(app: AppHandle) -> Result<String, String> {
    let path = resolve_taco_home(&app)?.join("desktop.json");
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(e) => Err(format!("failed to read desktop.json: {e}")),
    }
}

#[tauri::command]
async fn desktop_config_write(app: AppHandle, contents: String) -> Result<(), String> {
    let dir = resolve_taco_home(&app)?;
    let path = dir.join("desktop.json");
    let tmp = dir.join("desktop.json.tmp");
    tokio::fs::write(&tmp, contents)
        .await
        .map_err(|e| format!("failed to write desktop.json.tmp: {e}"))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("failed to rename desktop.json.tmp: {e}"))?;
    Ok(())
}

/// (Implementation lives in `upgrade_commands.rs` so this Tauri-command
///  layer stays focused on the workspace_* handlers.)

pub struct AppState {
    /// The single shared sidecar process. Lock is held only across install / dispose;
    /// spawn runs outside the lock so dispose can acquire it, set the shutdown flag, and
    /// have the ensure pre-check see the flag before install — killing the orphan instead
    /// of leaving a zombie after a dispose race-kill.
    pub sidecar: Mutex<Option<SharedSidecar>>,
    next_process_generation: AtomicU64,
    /// True while a dispose is in flight — ensure checks this before AND after spawn so it
    /// never installs a process that will be killed moments later (orphan).
    shutdown_initiated: AtomicBool,
    /// Per-process log file family, set when a sidecar is installed. None
    /// before the first install; recreated on each new sidecar process so the
    /// file's lifetime matches the process lifetime. The reader task gets a
    /// clone of the inner `Arc` at install time (see `workspace_ensure`), so
    /// it can outlive the slot install without holding the Tauri State — and
    /// so a parallel aborting ensure never shares a handle with the winning
    /// one. The double-Arc is load-bearing: outer is the install-publish
    /// point (one writer at a time, behind a sync mutex since Tauri `State<T>`
    /// only `Deref`s to `T`); inner is the handle each reader owns.
    pub log_files: Arc<StdMutex<Option<Arc<StdMutex<LogFiles>>>>>,
    /// JoinHandle of the running stderr reader task. A restart joins the prior
    /// generation's reader before opening the log files: the reader's final
    /// `flush` can itself trip a rotation (the rename chain), and two readers
    /// holding independent `LogFiles` mutexes on the same fixed paths would
    /// race those renames.
    pub stderr_reader: StdMutex<Option<tokio::task::JoinHandle<()>>>,
    /// Serializes the whole workspace_ensure sequence (spawn → install).
    /// Without it, N concurrent first-start callers each spawn their own
    /// launcher. Under the lock, a later caller always observes a consistent
    /// state: no slot, or an installed slot.
    pub ensure_lock: Mutex<()>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sidecar: Mutex::new(None),
            next_process_generation: AtomicU64::new(1),
            shutdown_initiated: AtomicBool::new(false),
            log_files: Arc::new(StdMutex::new(None)),
            stderr_reader: StdMutex::new(None),
            ensure_lock: Mutex::new(()),
        }
    }
}

pub struct SharedSidecar {
    /// NDJSON frame writer. The reader task holds the other half of the
    /// connected socket via the Split writer; this channel lets `workspace_send`
    /// queue RPC lines without owning the socket directly.
    pub stdin_tx: mpsc::Sender<String>,
    /// Launcher process handle. `Some` until the launcher exits — in dev the
    /// launcher is the @taco-ai/cli (which exits after spawning the daemon
    /// bundle); in prod the launcher is the bundle itself in daemon mode (which
    /// stays alive until shutdown). Kept so `shutdown_sidecar` can send
    /// `control.shutdown` then SIGKILL as a fallback if the daemon doesn't
    /// exit within the grace window.
    pub launcher: Option<Child>,
    /// Generation counter — EOF on the NDJSON socket clears the slot only if
    /// the generation still matches (avoids an old reader wiping a freshly
    /// restarted daemon's handshake line).
    generation: u64,
}

/// Platform-specific NDJSON socket type. `UnixStream` on macOS /
/// Linux; `NamedPipeClient` on Windows. Both implement tokio's AsyncRead +
/// AsyncWrite so `tokio::io::split` produces a (ReadHalf, WriteHalf) pair.
#[cfg(unix)]
type DaemonStream = tokio::net::UnixStream;

#[cfg(windows)]
type DaemonStream = tokio::net::windows::named_pipe::NamedPipeClient;

/// Open a non-blocking connection to the daemon's NDJSON socket.
async fn connect_daemon_socket(path: &std::path::Path) -> Result<DaemonStream, String> {
    #[cfg(unix)]
    {
        tokio::net::UnixStream::connect(path)
            .await
            .map_err(|e| format!("unix socket connect {} failed: {e}", path.display()))
    }
    #[cfg(windows)]
    {
        // tokio 1.53 named-pipe client API: the builder is
        // `ClientOptions` (not `NamedPipeClientOptions`), and `open()`
        // returns an already-connected handle — `CreateFileW` on a pipe
        // client either connects immediately or fails with
        // `ERROR_PIPE_BUSY`, so there is no separate `connect()` step
        // on the client (the `connect()` method lives on
        // `NamedPipeServer`).
        let client = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(path)
            .map_err(|e| format!("named pipe open {} failed: {e}", path.display()))?;
        Ok(client)
    }
}

/// On Unix, `connect()` returns `ConnectionRefused` (ECONNREFUSED) when the
/// socket file exists but no listener is bound — the signature of a crashed
/// daemon that didn't unlink on exit. Unlink the entry so the launcher /
/// daemon can bind again. Returns true if a stale file was removed.
///
/// On Windows, named pipes are kernel objects without filesystem entries, so
/// nothing to clean up — the launcher sidecar self-cleans.
#[cfg(unix)]
async fn clear_stale_socket(path: &std::path::Path) -> bool {
    let probe = connect_daemon_socket(path).await;
    if let Err(_e) = probe {
        // Any error on a Unix socket that already has a file on disk means
        // stale: ENOENT (file vanished mid-probe), ECONNREFUSED (no listener),
        // EACCES (mode bit mismatch, recoverable on next start). Unlink is
        // idempotent under ENOENT — the `remove_file` call below swallows it.
        if path.exists() {
            match tokio::fs::remove_file(path).await {
                Ok(()) => return true,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
                Err(e) => {
                    eprintln!(
                        "taco-desktop: failed to remove stale socket {}: {e}",
                        path.display()
                    );
                    return false;
                }
            }
        }
    }
    false
}

#[cfg(not(unix))]
async fn clear_stale_socket(_path: &std::path::Path) -> bool {
    false
}

/// Ceiling for the NDJSON liveness probe's reply. The daemon answers an
/// unknown method from its handler registry without touching disk, a model,
/// or a subprocess, so a healthy one replies in single-digit milliseconds even
/// mid-boot. 2s is generous enough to absorb a loaded machine while still
/// failing fast against a daemon whose event loop is starved.
const NDJSON_PROBE_TIMEOUT: Duration = Duration::from_millis(2_000);

/// Confirm the listener on `path` is actually serving NDJSON, not merely
/// bound. `connect()` succeeds as long as the kernel's listen queue exists,
/// which stays true while the owning process is alive but no longer turning
/// its event loop — a daemon in a GC death spiral accepts connections and
/// answers nothing. Treating connect-success as readiness is what let
/// `ensure` install such a daemon and leave the sidebar empty for ~50s:
/// five `session.list` calls burned the full 15s `FAST_RPC_TIMEOUT_MS`
/// before EOF surfaced the truth.
///
/// The probe sends one frame and requires *any* reply. `initialize` is
/// NOT used: it is a stateful handshake the frontend owns, and completing
/// it here would leave the daemon believing this throwaway connection is
/// the initialized client. A dummy method trips the pre-handshake guard
/// and returns `not_initialized` — a good pong, since producing it means
/// read loop, JSON parse, and writer are all still scheduled.
async fn probe_daemon_ndjson(conn: &mut DaemonStream) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    // `id` must be a string: the daemon drops frames whose id is not one
    // (see SidecarServer.handleLine) and we would wait out the timeout.
    let frame = "{\"id\":\"__desktop_liveness_probe\",\"method\":\"__liveness__\",\"params\":{}}\n";
    let io = async {
        conn.write_all(frame.as_bytes())
            .await
            .map_err(|e| format!("probe write failed: {e}"))?;
        let mut line = String::new();
        let n = BufReader::new(conn)
            .read_line(&mut line)
            .await
            .map_err(|e| format!("probe read failed: {e}"))?;
        if n == 0 {
            return Err("probe saw EOF (daemon closed the connection)".to_string());
        }
        Ok(())
    };
    match tokio::time::timeout(NDJSON_PROBE_TIMEOUT, io).await {
        Ok(r) => r,
        Err(_) => Err(format!(
            "daemon accepted the connection but did not answer within {}ms",
            NDJSON_PROBE_TIMEOUT.as_millis()
        )),
    }
}

/// Poll the daemon socket (with backoff) until it answers an NDJSON probe or
/// the deadline expires. Mirrors packages/cli/lib/start.ts `waitForSocket`
/// so the launcher and the desktop agree on the "ready" heuristic.
///
/// Readiness requires a round-trip, not just a successful `connect()` — see
/// `probe_daemon_ndjson` for why the weaker check silently installed wedged
/// daemons. On first failure we proactively clear any stale socket file (the
/// sidecar's own startup probe does the same in `probeNdjsonSocket`): a
/// crashed daemon's socket would let `connect()` succeed against a ghost
/// listener, the next NDJSON read sees EOF, and the UI stalls silently.
async fn wait_for_daemon_socket(path: &std::path::Path, timeout: Duration) -> Result<(), String> {
    let probe_interval = Duration::from_millis(50);
    let deadline = tokio::time::Instant::now() + timeout;
    let mut stale_checked = false;
    loop {
        match connect_daemon_socket(path).await {
            Ok(mut conn) => match probe_daemon_ndjson(&mut conn).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    // Bound but not serving. Retrying is still worthwhile: a
                    // daemon mid-boot can accept before its handler registry
                    // is reachable, and the caller's deadline decides when to
                    // give up. Do NOT unlink here — the socket has a live
                    // owner, so removing the file would strand it while the
                    // next bind races the same inode. `reap_previous_daemon`
                    // owns killing a wedged daemon.
                    if tokio::time::Instant::now() >= deadline {
                        return Err(format!(
                            "daemon socket {} bound but not serving within {}ms ({e})",
                            path.display(),
                            timeout.as_millis()
                        ));
                    }
                    tokio::time::sleep(probe_interval).await;
                }
            },
            Err(e) => {
                if !stale_checked {
                    if clear_stale_socket(path).await {
                        eprintln!(
                            "taco-desktop: removed stale socket at {} ({}); retrying",
                            path.display(),
                            e
                        );
                    }
                    stale_checked = true;
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(format!(
                        "daemon socket {} not ready within {}ms (last error: {e})",
                        path.display(),
                        timeout.as_millis()
                    ));
                }
                tokio::time::sleep(probe_interval).await;
            }
        }
    }
}

/// macOS only: open the workspace directory once from this frontmost app
/// process. The first access to a TCC-protected ancestor (e.g. ~/Documents)
/// then surfaces the "allow access" consent prompt immediately as a modal.
/// Without this, the first access happens inside the background sidecar
/// process, and macOS defers that prompt to a banner tens of seconds later —
/// blocking session load until the user notices it. The grant covers the
/// whole app (sidecar child included), so the prompt appears at most once
/// per protected folder.
#[cfg(target_os = "macos")]
fn prewarm_workspace_access(cwd: &str) {
    if let Err(e) = std::fs::read_dir(cwd) {
        eprintln!("taco-desktop: workspace prewarm read_dir({cwd}) failed: {e}");
    }
}

/// Give `tauri dev` the same rounded dock icon the installed app gets.
/// The bundled icon.icns is full-bleed with opaque corners; macOS 26 shrinks
/// icons with transparent margins inside a gray tray, and applies its own
/// squircle mask to whatever the bundle ships. In dev there is no bundle, so
/// Tauri passes icon.icns unmasked and the art reads as a hard-edged square.
/// icon-dev-dock.png is that same art pre-masked with the system squircle.
/// Tauri sets the dev dock icon on RunEvent::Ready, so this has to run
/// after that or it gets overwritten. Release builds never reach here.
#[cfg(all(target_os = "macos", debug_assertions))]
fn apply_dev_dock_icon() {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let png = include_bytes!("../icons/icon-dev-dock.png");
    // Ready is delivered on the main thread, which is what NSApplication requires.
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("taco-desktop: dev dock icon skipped — not on main thread");
        return;
    };
    let data = NSData::with_bytes(png);
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
        eprintln!("taco-desktop: dev dock icon decode failed");
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    unsafe { app.setApplicationIconImage(Some(&image)) };
}

/// Ensure the shared sidecar process exists. First call spawns; subsequent calls with any cwd
/// return immediately — the sidecar itself lazy-builds WorkspaceRuntime when it receives an
/// RPC with `params.workspace`, so Rust does nothing for new workspaces.
///
/// `cwd` is only used on the first spawn to decide the working directory in repo-source mode.
///
/// Sidecar spawn-time env (e.g. `TACO_DEBUG_LLM_PAYLOAD` from the Debug
/// tab's `debugMode` toggle) is read from `~/.taco/desktop.json` at every
/// spawn so prewarm, reconnect, and Apply & Restart all see the same
/// value — localStorage alone is unreachable from this Tauri command.
///
/// Rust is a pure byte pipe: every NDJSON line (including initialize responses) is forwarded
/// to the frontend verbatim as `sidecar-event`, and the frontend drives the handshake. A
/// late-attaching client just resends initialize — no replay mechanism is needed.
#[tauri::command]
async fn workspace_ensure(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
) -> Result<(), String> {
    boot_trace::mark_rust_detail("ensure.enter", &cwd);
    // The TCC suspect: a synchronous read_dir on a protected ancestor (e.g.
    // ~/Documents) can stall here waiting on a consent decision, before the
    // ensure_lock is even taken. Timed separately so a stall here is
    // unambiguous rather than being attributed to the spawn below.
    #[cfg(target_os = "macos")]
    {
        let _p = boot_trace::Phase::new("ensure.prewarm_workspace_access");
        prewarm_workspace_access(&cwd);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = cwd;

    // Phase 1 (lock-free): fast-path slot check + idempotent reap. The reap
    // runs without the ensure_lock because it does not race with anything
    // (unlink is idempotent, SIGTERM is idempotent). Moving it out of the
    // lock window is what removes the 4s+ reap from the cold-start critical
    // path: a stale daemon killed by an earlier ensure no longer blocks the
    // next caller's spawn, and a hung daemon's SIGTERM grace overlaps with
    // the webview's own load instead of stalling it.
    {
        let slot = state.sidecar.lock().await;
        if slot.as_ref().is_some() {
            boot_trace::mark_rust("ensure.slot_already_present");
            return Ok(());
        }
        if state.shutdown_initiated.load(Ordering::Acquire) {
            boot_trace::mark_rust("ensure.shutdown_initiated");
            return Err("sidecar shutting down".into());
        }
    }
    {
        let _p = boot_trace::Phase::new("ensure.reap_stale");
        if let Ok(runtime_dir) = resolve_taco_runtime_dir(&app) {
            reap_stale_at(&runtime_dir, &app);
        }
    }

    let resolution = {
        let _p = boot_trace::Phase::new("ensure.resolve_sidecar");
        resolve_sidecar(&app)?
    };
    let socket_path = resolution.socket_path.clone();

    let mut cmd = Command::new(&resolution.program);
    for a in &resolution.args {
        cmd.arg(a);
    }
    if resolution.use_repo_source {
        let repo_root = find_repo_root();
        cmd.current_dir(&repo_root);
    }

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }

    // PR2 daemon-mode spawn: stdin / stdout are unused by the daemon (the
    // bundle reads from TACO_SOCKET and writes to the NDJSON socket), so we
    // null them out. Capture stderr into a buffer so a launcher crash surfaces
    // in the returned error — before this change, `Stdio::inherit()` left the
    // real cause in the terminal and the UI saw a generic sidecar timeout
    // after the socket-wait elapsed. The buf is capped at 4 KiB so
    // a chatty daemon cannot grow it without bound.
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    cmd.env_clear();
    for key in PASSTHROUGH_ENV {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
    // Debug builds additionally forward NODE_OPTIONS so V8 diagnostic flags
    // reach the daemon. Compiled out of release entirely — see
    // DEBUG_ONLY_PASSTHROUGH_ENV for why this is not unconditional.
    #[cfg(debug_assertions)]
    for key in DEBUG_ONLY_PASSTHROUGH_ENV {
        if let Ok(v) = std::env::var(key) {
            boot_trace::mark_rust_detail("ensure.debug_env_forwarded", &format!("{key}={v}"));
            cmd.env(key, v);
        }
    }
    let resolved_home = resolve_taco_home(&app)?;
    cmd.env("TACO_HOME", &resolved_home);

    if let Some(resources) = &resolution.resources_root {
        cmd.env("TACO_SIDECAR_RESOURCES", resources);
    }

    for (key, value) in &resolution.extra_env {
        cmd.env(key, value);
    }
    // Sidecar spawn-time env: read `debugMode` from `~/.taco/desktop.json`,
    // which the Debug tab mirrors to disk on every toggle. Disk is the
    // authoritative source so every spawn path (prewarm, reconnect, the
    // explicit Apply & Restart) reflects the user's setting — the Debug tab
    // is the only place this can change, and it always writes disk before
    // allowing a restart. The `debug_mode` parameter on this command is
    // kept for backwards compatibility but ignored: the disk value is the
    // contract. (The previous daemon-mode refactor dropped this injection
    // entirely; restore it next to `extra_env` so future refactors don't
    // strand the parameter again.)
    if read_desktop_config_debug_mode(&app) {
        cmd.env("TACO_DEBUG_LLM_PAYLOAD", "1");
    }
    // LLM dump-to-disk toggle (Debug tab → `llmDumpToFile` switch, mirrored
    // to `~/.taco/desktop.json` by DebugTab + useAppLifecycle). The sidecar
    // is unaware of this: it keeps writing `[taco:llm]` lines whenever
    // debugMode is on, and the Rust stderr reader (spawned below) decides
    // whether to mirror them into `$TACO_HOME/logs/llm-dump.log`. Default
    // off — the disk file holds plaintext conversation in the user's home
    // dir, so this stays a separate opt-in.
    let llm_dump_to_file = read_desktop_config_llm_dump_to_file(&app);
    // The logs dir must exist regardless of the toggle: the daemon's own
    // stderr tee (`TACO_STDERR_LOG` → daemon.err.log, set below) does not
    // create its parent directory. Best-effort — `LogFiles::open` retries
    // this when the toggle is on.
    if let Err(e) = log_file::ensure_logs_dir(&resolved_home) {
        eprintln!("taco-desktop: failed to create logs dir: {e}");
    }
    // Per-process log files. Owned by the stderr reader (which clones the
    // Arc into its task below) and *only* published to `state.log_files`
    // on the winning-install path — aborting ensures must leave the field
    // untouched (see install_publish test). Opened only when the toggle is
    // on: `LogFiles::open` eagerly creates `llm-dump.log`, and an opted-out
    // user should not find the plaintext-target file in their home dir.
    // Open failure is best-effort: the reader falls back to a no-op tee.
    let log_files: Option<std::sync::Arc<std::sync::Mutex<LogFiles>>> = if llm_dump_to_file {
        match LogFiles::open(&resolved_home) {
            Ok(files) => Some(std::sync::Arc::new(std::sync::Mutex::new(files))),
            Err(e) => {
                eprintln!("taco-desktop: failed to open log files: {e}");
                None
            }
        }
    } else {
        None
    };
    let log_files_for_reader = log_files.clone();
    // Tee daemon stderr to the same file launchd uses (best-effort).
    // The desktop spawn path does not go through launchd, so without
    // this the daemon's logs would only survive in the parent's captured
    // stderr buffer (capped at 4 KiB and lost on app quit).
    let stderr_log_path = resolved_home.join("logs").join("daemon.err.log");
    cmd.env("TACO_STDERR_LOG", &stderr_log_path);

    // Phase 2 (ensure_lock): serialize the spawn window only. The lock is
    // dropped as soon as the launcher is forked and the stderr reader is
    // attached, so a second ensure() that arrives mid-wait (or mid-bind)
    // sees the slot populated by the first one and returns Ok(())
    // immediately. Without this narrowing, a 4s reap inside the lock
    // blocked every other ensure behind it for 4s+ and forced the UI
    // through a doomed attempt0 → attempt1 retry chain (~6s wasted).
    let _ensure_guard = {
        let _p = boot_trace::Phase::new("ensure.acquire_ensure_lock");
        state.ensure_lock.lock().await
    };
    {
        let slot = state.sidecar.lock().await;
        if slot.as_ref().is_some() {
            boot_trace::mark_rust("ensure.slot_already_present_late");
            return Ok(());
        }
        if state.shutdown_initiated.load(Ordering::Acquire) {
            boot_trace::mark_rust("ensure.shutdown_initiated_pre_spawn");
            return Err("sidecar shutting down".into());
        }
    }

    boot_trace::mark_rust("ensure.launcher_spawn");
    let mut launcher = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar launcher: {e}"))?;
    boot_trace::mark_rust_detail("ensure.launcher_spawned", &format!("pid={:?}", launcher.id()));
    let generation = state
        .next_process_generation
        .fetch_add(1, Ordering::Relaxed);

    // Drain the launcher's stderr two ways: (1) forward lines to the frontend
    // as `sidecar-log` Tauri events for the Debug tab's LLM Dump panel and
    // the warning/error banner (parseLogLine); (2) keep the last 4 KiB in
    // stderr_buf for error reporting on a non-zero launcher exit.
    //
    // (1) was dead in the daemon-mode refactor — the old inline sidecar had
    // a 1:1 stdout pipe Rust forwarded; the new launcher→daemon chain only
    // read stderr to capture a launch-failure tail buffer. Lines are
    // **batched** ({lines: string[]}, not one-event-per-line) because a
    // single LLM call dumps hundreds of folded `[taco:llm]` lines that
    // queued header behind body and overwhelmed Tauri IPC. A 50ms / 64-line
    // flush keeps end-to-end latency under ~100ms while dropping IPC
    // traffic by an order of magnitude.
    let stderr_buf: std::sync::Arc<std::sync::Mutex<Vec<u8>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::with_capacity(4096)));
    if let Some(stderr) = launcher.stderr.take() {
        let buf = std::sync::Arc::clone(&stderr_buf);
        let app_for_stderr = app.clone();
        let log_files = log_files_for_reader;
        tokio::spawn(async move {
            use std::time::Duration;
            use tokio::io::{AsyncBufReadExt, BufReader};
            use tokio::time::MissedTickBehavior;
            let mut line_buf: Vec<u8> = Vec::with_capacity(512);
            let mut reader = BufReader::new(stderr);
            let mut batch: Vec<String> = Vec::with_capacity(64);
            let mut ticker = tokio::time::interval(Duration::from_millis(50));
            ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    read = reader.read_until(b'\n', &mut line_buf) => {
                        match read {
                            Ok(0) => {
                                // EOF: flush whatever is buffered, then exit.
                                if !batch.is_empty() {
                                    let _ = app_for_stderr.emit(
                                        "sidecar-log",
                                        serde_json::json!({ "lines": &batch }),
                                    );
                                }
                                break;
                            }
                            Ok(_) => {
                                // Tail buffer: append raw bytes (incl. newline).
                                {
                                    let mut g = buf.lock().unwrap();
                                    let room = 4096usize.saturating_sub(g.len());
                                    if room > 0 {
                                        if line_buf.len() > room {
                                            let start = line_buf.len() - room;
                                            g.extend_from_slice(&line_buf[start..]);
                                        } else {
                                            g.extend_from_slice(&line_buf);
                                        }
                                    }
                                }
                                let trimmed =
                                    line_buf.strip_suffix(b"\n").unwrap_or(&line_buf);
                                let line = String::from_utf8_lossy(trimmed).into_owned();
                                if !line.is_empty() {
                                    // Tee to llm-dump.log when the toggle is on
                                    // (log_files is only opened then) and the line
                                    // is a sidecar-emitted `[taco:llm]` payload.
                                    // Best-effort: a write error here only prints
                                    // to stderr, never aborts the reader task
                                    // (losing the in-memory panel would be a
                                    // worse failure than losing the disk file).
                                    if line.starts_with("[taco:llm]") {
                                        if let Some(lf) = log_files.as_ref() {
                                            let mut g = lf.lock().unwrap();
                                            if let Err(e) = g.llm.write_line(&line) {
                                                eprintln!(
                                                    "taco-desktop: llm-dump write failed: {e}"
                                                );
                                            }
                                        }
                                    }
                                    batch.push(line);
                                    if batch.len() >= 64 {
                                        let _ = app_for_stderr.emit(
                                            "sidecar-log",
                                            serde_json::json!({ "lines": &batch }),
                                        );
                                        batch.clear();
                                    }
                                }
                                line_buf.clear();
                            }
                            Err(_) => break,
                        }
                    }
                    _ = ticker.tick() => {
                        if !batch.is_empty() {
                            let _ = app_for_stderr.emit(
                                "sidecar-log",
                                serde_json::json!({ "lines": &batch }),
                            );
                            batch.clear();
                        }
                    }
                }
            }
        });
    }

    // Spawn window closed — drop the ensure_lock so concurrent ensure()
    // callers can race into their own slot check (and most of them will
    // see the slot Some installed by the first finisher, returning
    // immediately). The wait + connect + install below all run with only
    // the state.sidecar mutex, not the ensure_lock.
    drop(_ensure_guard);
    boot_trace::mark_rust("ensure.spawn_window_closed");

    // Wait for the daemon to bind the socket, then connect. The bundle (in
    // daemon mode) prints nothing on stdout, so we poll the socket path
    // instead. 15s mirrors the CLI's waitForSocket and covers a cold dev
    // boot (tsx recompiling the sidecar source); a stalled spawn surfaces
    // here rather than hanging the UI.
    //
    // Race: if the launcher exits non-zero *before* the socket is ready, the
    //   real cause is whatever the launcher printed to stderr. Surface that
    //   immediately instead of waiting for the 5s socket timeout to elapse.
    // Race socket readiness against launcher exit. Only a non-zero exit is a
    // hard failure — exit 0 means the launcher finished successfully, so the
    // daemon should be listening; we give the socket poll one more short
    // window in that case (the fast path — `taco start` probes control then
    // exits 0 — can otherwise lose the race and produce a misleading
    // "launcher exited" error on slow machines).
    let _wait_phase = boot_trace::Phase::new("ensure.wait_for_daemon_socket");
    let wait_result = tokio::select! {
        r = wait_for_daemon_socket(&socket_path, Duration::from_secs(15)) => r,
        exit = launcher.wait() => {
            let status = match exit {
                Ok(s) => s,
                Err(e) => return Err(format!("failed to wait on launcher: {e}")),
            };
            if !status.success() {
                // Real failure: capture stderr and surface immediately.
                tokio::time::sleep(Duration::from_millis(50)).await;
                let mut captured = stderr_buf.lock().unwrap().clone();
                while captured.last().map_or(false, |b| b.is_ascii_whitespace() || *b == 0) {
                    captured.pop();
                }
                let stderr_tail = String::from_utf8_lossy(&captured).into_owned();
                return Err(format!(
                    "sidecar launcher exited before binding socket (status: {}{})",
                    status,
                    if stderr_tail.is_empty() {
                        String::new()
                    } else {
                        format!("; stderr: {}", stderr_tail)
                    },
                ));
            }
            // Exit 0 — daemon should be up; one more short socket poll
            // before we call it a failure. Window widened from 500ms to 2s:
            // on slow machines the daemon can take 1-2s to bind NDJSON
            // after the CLI exits 0, so the old window produced
            // misleading "sidecar exited" errors on first cold-start.
            // The next ensure() would self-heal via probeNdjsonSocket.
            wait_for_daemon_socket(&socket_path, Duration::from_millis(2_000)).await
        }
    };
    wait_result?;

    drop(_wait_phase);
    // Belt-and-suspenders: the select! above either returned a successful
    // wait or surfaced the launcher's exit code. Anything else (a stray
    // connect() error after the launcher exited cleanly, a transient
    // race) would otherwise leave this process holding a launcher that
    // never publishes its slot — a quiet orphan that leaks until the
    // parent exits. Kill it so the next ensure() starts from a clean
    // baseline. Inside `?` propagation we know the launcher is the sole
    // owner of the fd by this point.
    let conn = {
        let _p = boot_trace::Phase::new("ensure.connect_daemon_socket");
        connect_daemon_socket(&socket_path).await?
    };
    let (mut read_half, mut write_half) = tokio::io::split(conn);

    // Writer task: `workspace_send` queues NDJSON frames on stdin_tx; we
    // write each one + \n to the socket. Closing stdin_tx (the launcher
    // going away) ends the loop.
    let (tx, mut rx) = mpsc::channel::<String>(64);
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if write_half.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    // Reader task: every NDJSON frame from the socket is forwarded to the
    // frontend as `sidecar-event`. Rust stays a dumb byte pipe — the frontend
    // drives the initialize handshake itself, so there is no first-frame
    // special-casing to maintain.
    let app_for_reader = app.clone();
    let reader_handle = tokio::spawn(async move {
        let mut reader = BufReader::new(&mut read_half).lines();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    let _ = app_for_reader
                        .emit("sidecar-event", serde_json::json!({ "line": line }));
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("taco-desktop NDJSON read error: {e}");
                    break;
                }
            }
        }

        // Socket EOF ⇒ daemon exited. Generation match guards against
        // clobbering a freshly restarted daemon's slot.
        let dead = {
            let state = app_for_reader.state::<AppState>();
            let mut slot = state.sidecar.lock().await;
            let matches_generation = slot
                .as_ref()
                .map(|s| s.generation == generation)
                .unwrap_or(false);
            if matches_generation {
                slot.take()
            } else {
                None
            }
        };
        if dead.is_some() {
            let _ = app_for_reader.emit("sidecar-exited", serde_json::json!({ "code": null }));
        }
    });

    // Third check: re-check shutdown flag and slot before install — if dispose was
    // triggered during spawn, or a concurrent ensure already installed, kill the orphan
    // launcher we just spawned.
    // Lock-free ensure_guard above means this race is the new normal rather
    // than a corner case: every second ensure() that enters after the first
    // has released its spawn-window guard ends up here, sees Some(_), and
    // dies fast instead of re-running the whole 6s spawn chain.
    let mut slot = state.sidecar.lock().await;
    if state.shutdown_initiated.load(Ordering::Acquire) {
        drop(tx);
        launcher.kill().await.ok();
        launcher.wait().await.ok();
        std::mem::drop(reader_handle);
        return Err("sidecar shutting down".into());
    }
    if slot.as_ref().is_some() {
        boot_trace::mark_rust("ensure.slot_install_lost_race");
        drop(tx);
        launcher.kill().await.ok();
        launcher.wait().await.ok();
        std::mem::drop(reader_handle);
        return Ok(());
    }

    // Winning install. PR2 deliberately left `state.log_files` as None on
    // the daemon path; with llmDumpToFile support we publish the Arc here
    // only on the winning path so aborting ensures leave the field
    // untouched (matches the install_publish invariant). The stderr reader
    // already holds its own Arc clone (captured at spawn time) and writes
    // to its own file regardless of publish state — the publish is purely
    // for future readers of `state.log_files`.
    *slot = Some(SharedSidecar {
        stdin_tx: tx,
        launcher: Some(launcher),
        generation,
    });
    if let Some(lf) = log_files {
        *state.log_files.lock().unwrap() = Some(lf);
    }
    boot_trace::mark_rust("ensure.slot_installed");
    Ok(())
}

/// Frontend → boot trace bridge. The webview's own console never reaches disk,
/// so the UI's boot phases would otherwise be invisible in post-hoc diagnosis
/// while the Rust phases are fully traced. Routing them into the same file puts
/// both sides on one timeline with one clock.
///
/// Offsets are stamped Rust-side on arrival rather than passed in by the
/// caller, so UI marks share the process-start origin with the Rust marks
/// instead of being measured against a separate JS epoch. That does fold IPC
/// latency into each UI mark, which is the right trade here: we care about
/// which phase is slow, and an inflated-by-milliseconds offset cannot disguise
/// a multi-second stall.
#[tauri::command]
fn boot_mark(label: String, detail: Option<String>) {
    boot_trace::mark("ui", &label, detail.as_deref().unwrap_or(""));
}

/// All workspaces share one stdin — `cwd` is kept only for API compatibility, not for
/// routing. The request body carries `params.workspace`; the sidecar routes it.
#[tauri::command]
async fn workspace_send(
    state: State<'_, AppState>,
    cwd: String,
    line: String,
) -> Result<(), String> {
    let _ = cwd;
    let tx = {
        let slot = state.sidecar.lock().await;
        slot.as_ref()
            .map(|s| s.stdin_tx.clone())
            .ok_or("sidecar not started")?
    };
    tx.send(line).await.map_err(|e| format!("send failed: {e}"))
}

/// Kill the shared sidecar process — the landing point for the frontend's `client.dispose()`
/// / restartSidecar.
#[tauri::command]
async fn workspace_dispose_all(app: AppHandle) -> Result<(), String> {
    shutdown_sidecar(&app).await;
    Ok(())
}

/// Gracefully stop the shared sidecar child and reset the shutdown flag.
///
/// PR-D reorders the teardown so the daemon gets a chance to clean up its
/// own sockets + pid file before any signal lands:
///   1. Set `shutdown_initiated` so concurrent `workspace_ensure` aborts.
///   2. Take the slot; drop `stdin_tx` so the writer task flushes
///      pending NDJSON frames before the socket closes.
///   3. Send `control.shutdown` to the daemon's control socket and wait
///      up to 3s for it to ack + exit. This is the only path that
///      cleans up sockets + pid file from inside the daemon process.
///   4. If the daemon didn't ack (dev mode orphan, prod where the
///      launcher IS the daemon and the bundle refused shutdown), reap
///      via the pid file -- this catches the case where the launcher
///      handle points at a CLI process that's already exited.
///   5. As a final fallback, kill the launcher handle directly.
///   6. Reset the shutdown flag.
async fn shutdown_sidecar(app: &tauri::AppHandle) {
    // Set the flag BEFORE acquiring the lock — any in-flight ensure (already past the first
    // check, mid-spawn) sees it before install, so it kills the orphan launcher instead of
    // being race-killed and leaving a zombie. Reset is outside the lock: the typical path
    // is dispose → re-ensure (restartSidecar), and after reset the next ensure can spawn.
    let state = app.state::<AppState>();
    state.shutdown_initiated.store(true, Ordering::Release);
    let dead = {
        let mut slot = state.sidecar.lock().await;
        slot.take()
    };
    if let Some(mut s) = dead {
        drop(s.stdin_tx);
        // Compute the control socket path so we can ask the daemon to
        // shut itself down. Resolved lazily -- failure to resolve
        // the daemon runtime directory just means we skip the control.shutdown
        // step and fall through to the reap path.
        let control_path = resolve_taco_runtime_dir(app)
            .ok()
            .map(|runtime_dir| control_socket_path(&runtime_dir));
        if let Some(control) = control_path {
            // Best-effort: 3s window for control.shutdown to land. A
            // success path means the daemon ack'd and is exiting on its
            // own -- no signal needed, sockets + pid file get cleaned
            // up by the daemon's shutdown handler.
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                send_control_shutdown(control.clone()),
            )
            .await;
            // control.shutdown is ack-then-async-teardown: the daemon replies,
            // then stops IM/scheduler and only afterwards closes + unlinks its
            // sockets. A re-ensure landing in that teardown window would probe
            // the still-bound socket, see "ready", and reuse the dying daemon —
            // silently keeping the old spawn env (e.g. no TACO_DEBUG_LLM_PAYLOAD
            // after a debug-mode restart). Wait until the control socket stops
            // accepting connections before returning so the next ensure spawns
            // a fresh process.
            #[cfg(unix)]
            let _ =
                tokio::time::timeout(Duration::from_secs(3), wait_for_control_socket_gone(control))
                    .await;
        }
        #[cfg(unix)]
        {
            // Reap covers the dev-mode orphan (CLI launcher already exited;
            // daemon detached and unreachable via launcher handle) and the
            // rare prod case where the daemon is wedged and ignored
            // control.shutdown.
            if let Ok(runtime_dir) = resolve_taco_runtime_dir(app) {
                reap_stale_at(&runtime_dir, app);
            }
        }
        // Final fallback: kill the launcher handle directly. In dev
        // this is the CLI (already exited; kill is a no-op); in prod
        // this is the daemon bundle itself.
        if let Some(mut launcher) = s.launcher.take() {
            match tokio::time::timeout(Duration::from_secs(3), launcher.wait()).await {
                Ok(_) => {}
                Err(_) => {
                    let _ = launcher.kill().await;
                    let _ = launcher.wait().await;
                }
            }
        }
    }
    state.shutdown_initiated.store(false, Ordering::Release);
}

/// Poll the control socket until it stops accepting connections — i.e. the
/// daemon finished its async teardown and exited. Returns on the first failed
/// connect; callers wrap this in a timeout. Unix-only (named-pipe daemons on
/// Windows go through the service manager, not this path).
#[cfg(unix)]
async fn wait_for_control_socket_gone(path: std::path::PathBuf) {
    use tokio::net::UnixStream;
    loop {
        if UnixStream::connect(&path).await.is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Send `control.shutdown` to the daemon's control socket and read the
/// ack. Returns Ok if the daemon responded within the caller's timeout;
/// any error means "didn't ack in time" and the caller should fall
/// through to reap/kill.
async fn send_control_shutdown(path: std::path::PathBuf) -> Result<(), String> {
    #[cfg(unix)]
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::UnixStream;
        let mut stream = UnixStream::connect(&path)
            .await
            .map_err(|e| format!("connect {} failed: {e}", path.display()))?;
        stream
            .write_all(b"{\"method\":\"control.shutdown\",\"id\":1}\n")
            .await
            .map_err(|e| format!("write failed: {e}"))?;
        let mut buf = [0u8; 256];
        let _ = tokio::time::timeout(Duration::from_secs(1), stream.read(&mut buf)).await;
        // Either an ack or EOF is success -- the daemon flushes the
        // reply then exits, so any read completion means shutdown was
        // accepted.
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        // Windows: control.shutdown is sent via a JSON-RPC frame over
        // the named pipe. The CLI's `taco stop` already exercises this;
        // the desktop's shutdown path defers to launchd/schtasks on
        // Windows. Reserved for the future case where the desktop
        // runs without a service manager (dev mode).
        Ok(())
    }
}

/// Grant the FS plugin access to `path` and all its subdirectories.
/// Note: scope accumulates per call — paths are never revoked by tauri-plugin-fs 2.x.
#[tauri::command]
async fn set_fs_scope(app: AppHandle, path: String) -> Result<(), String> {
    let normalized = normalize_cwd(&path);
    let scope = app.fs_scope();
    scope
        .allow_directory(&normalized, true)
        .map_err(|e| format!("allow_directory failed: {e}"))?;
    Ok(())
}

/// The sidecar version this desktop would spawn — the expectation for the
/// reap freshness gate. Debug reads the repo's `packages/sidecar/package.json`;
/// release reads the staged bundle's `manifest.json` (`sidecarVersion`,
/// written by buildRuntime.mjs and staged by stageSidecar.mjs). Unreadable
/// → `None`, which disables the gate: reaping on every launch because a
/// metadata file went missing is worse than occasionally reusing an old
/// daemon.
fn expected_sidecar_version(app: &tauri::AppHandle) -> Option<String> {
    let raw = if cfg!(debug_assertions) {
        std::fs::read_to_string(
            find_repo_root()
                .join("packages")
                .join("sidecar")
                .join("package.json"),
        )
        .ok()?
    } else {
        let manifest = app.path().resource_dir().ok()?.join("sidecar").join("manifest.json");
        std::fs::read_to_string(strip_win_verbatim(&manifest)).ok()?
    };
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let key = if cfg!(debug_assertions) {
        "version"
    } else {
        "sidecarVersion"
    };
    value.get(key)?.as_str().map(String::from)
}

fn reap_stale_at(runtime_dir: &std::path::Path, app: &tauri::AppHandle) {
    use crate::daemon_reap::{
        compute_install_id, daemon_runtime_paths, reap_previous_daemon, ReapInputs,
    };
    let (pid_file, socket_path, control_socket_path) = daemon_runtime_paths(runtime_dir);
    // Best-effort resources root -- mirrors `resolve_sidecar`'s
    // priority exactly: debug builds always use the repo source root
    // (where `pnpm tauri:dev` runs the bundle from), release uses
    // Tauri's resource_dir (where the bundled sidecar sits). Without
    // the debug_assertions gate, dev runs would compute the id from
    // Tauri's target/debug resource_dir (which exists too), mismatch
    // the daemon's repo/packages/sidecar/src id, and reap would always
    // return ForeignInstall -- silently disabling dev-mode desktop reap.
    let resources_root = if cfg!(debug_assertions) {
        let root = find_repo_root();
        root.join("packages")
            .join("sidecar")
            .join("src")
            .to_string_lossy()
            .into_owned()
    } else {
        app.path()
            .resource_dir()
            .ok()
            .map(|p| p.join("sidecar").to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    // The install identity is derived from the shared user-data root, matching
    // the sidecar's `tacoHome()` call. The pid/socket locations above are
    // intentionally derived from the separate runtime directory.
    let taco_home = match resolve_taco_home(app) {
        Ok(home) => home,
        Err(_) => return,
    };
    let own_install_id = compute_install_id(&resources_root, &taco_home.to_string_lossy());
    let expected_version = expected_sidecar_version(app);
    let inputs = ReapInputs {
        pid_file,
        socket_path,
        control_socket_path,
        own_install_id: &own_install_id,
        expected_sidecar_version: expected_version.as_deref(),
        resources_root: std::path::PathBuf::from(&resources_root),
    };
    let outcome = reap_previous_daemon(&inputs, None);
    // Best-effort log only -- never block setup on a reap that finds
    // nothing. Operators see this in `pnpm tauri:dev` stderr.
    eprintln!("taco-desktop: reap outcome = {:?}", outcome);
}

/// Force-reap variant for the install path. Same shape as `reap_stale_at`
/// but invokes `force_reap`, which additionally terminates an alive own
/// daemon. Install is about to bounce launchd / schtasks, so any live
/// instance — even one whose control socket still answers — must die
/// pre-emptively to avoid racing the launcher respawn into a double-bind
/// on the same socket inode.
fn reap_force_at(runtime_dir: &std::path::Path, app: &tauri::AppHandle) {
    use crate::daemon_reap::{compute_install_id, daemon_runtime_paths, force_reap, ReapInputs};
    let (pid_file, socket_path, control_socket_path) = daemon_runtime_paths(runtime_dir);
    let resources_root = if cfg!(debug_assertions) {
        let root = find_repo_root();
        root.join("packages")
            .join("sidecar")
            .join("src")
            .to_string_lossy()
            .into_owned()
    } else {
        app.path()
            .resource_dir()
            .ok()
            .map(|p| p.join("sidecar").to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let taco_home = match resolve_taco_home(app) {
        Ok(home) => home,
        Err(_) => return,
    };
    let own_install_id = compute_install_id(&resources_root, &taco_home.to_string_lossy());
    let expected_version = expected_sidecar_version(app);
    let inputs = ReapInputs {
        pid_file,
        socket_path,
        control_socket_path,
        own_install_id: &own_install_id,
        expected_sidecar_version: expected_version.as_deref(),
        resources_root: std::path::PathBuf::from(&resources_root),
    };
    let outcome = force_reap(&inputs);
    eprintln!("taco-desktop: force_reap outcome = {:?}", outcome);
}

/// Auto-register the sidecar as an OS-level service on first run.
/// Registration is best-effort so startup remains available when a platform
/// launcher or optional service manager is unavailable.
fn should_auto_install_daemon_service(debug: bool) -> bool {
    !debug
}

/// Kick off the shared daemon spawn during app setup, overlapping its boot
/// with the webview's own load. Without this, a cold start serializes
/// "webview loads → frontend mounts → first workspace_ensure → daemon
/// spawn"; with it, the daemon is already booting while React hydrates.
/// The frontend still drives the `initialize` handshake on first mount —
/// `ensure_lock` serializes this prewarm with the frontend's first
/// `workspace_ensure`, so the command either finds the installed slot or
/// waits for (rather than racing) this spawn.
///
/// Spawn-time toggles (`debugMode` / `llmDumpToFile`) are read from
/// `~/.taco/desktop.json` by `workspace_ensure` itself, not from the
/// webview's localStorage — that file is unreadable from Rust. The Debug
/// tab's `useAppLifecycle` mirror copies localStorage → desktop.json on
/// mount so a cold-start prewarm still sees the user's choice. The
/// default off path therefore doesn't lose the setting; it just defers
/// the env injection to disk instead of in-memory state.
fn prewarm_daemon(app: &tauri::AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        boot_trace::mark_rust("prewarm.task_start");
        let cwd = {
            let _p = boot_trace::Phase::new("prewarm.target_cwd");
            prewarm_target_cwd(&handle).await
        };
        if cwd.is_empty() {
            boot_trace::mark_rust("prewarm.cwd_unresolved");
            return;
        }
        boot_trace::mark_rust_detail("prewarm.cwd", &cwd);
        let state = handle.state::<AppState>();
        let _p = boot_trace::Phase::new("prewarm.workspace_ensure");
        if let Err(e) = workspace_ensure(handle.clone(), state, cwd).await {
            // Best-effort: the frontend's first ensure surfaces the real
            // error to the UI; this log is for `tauri:dev` users.
            eprintln!("taco-desktop: daemon prewarm failed: {e}");
        }
    });
}

/// Resolve the cwd the prewarm should service. The previous version
/// unconditionally targeted `$TACO_HOME/workspace`, which had two costs:
///   1. The daemon ended up with a workspace runtime for a directory the
///      user is never going to open (sidebar never shows it, first
///      `session.list` on the active cwd still paid the cold-start price).
///   2. macOS TCC pre-warm on that directory was wasted work; the real
///      active workspace's first access still had to stall for consent.
///
/// Reading `~/.taco/desktop.json` directly is safe here — the file is the
/// authoritative store for `workspaces.active` (the Debug tab and
/// `setActiveCwd` flow mirror to disk synchronously), so a few hundred ms
/// staleness across cold start is acceptable. If the file is missing,
/// malformed, or the active cwd no longer exists, we silently fall back to
/// the historical `$TACO_HOME/workspace` default so prewarm remains a
/// best-effort optimization, not a hard requirement.
async fn prewarm_target_cwd(app: &tauri::AppHandle) -> String {
    #[cfg(unix)]
    {
        if let Some(cwd) = read_active_cwd_from_desktop_json(app) {
            boot_trace::mark_rust_detail("prewarm.cwd_source", "desktop.json.active");
            return cwd;
        }
    }
    match default_workspace_dir(app.clone()).await {
        Ok(dir) => {
            boot_trace::mark_rust_detail("prewarm.cwd_source", "default_workspace_dir");
            dir
        }
        Err(_) => {
            boot_trace::mark_rust("prewarm.cwd_source_failed");
            String::new()
        }
    }
}

/// Read `workspaces.active` from `~/.taco/desktop.json`. Returns None on any
/// failure (missing file, malformed JSON, missing key, directory gone) so
/// the caller can fall back without surfacing an error to the user.
#[cfg(unix)]
fn read_active_cwd_from_desktop_json(app: &tauri::AppHandle) -> Option<String> {
    let home = resolve_taco_home(app).ok()?;
    let path = home.join("desktop.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let cwd = value
        .get("workspaces")
        .and_then(|w| w.get("active"))
        .and_then(|a| a.as_str())?
        .to_string();
    if cwd.is_empty() || !std::path::Path::new(&cwd).exists() {
        return None;
    }
    Some(cwd)
}

fn ensure_daemon_installed(app: &tauri::App) -> tauri::Result<()> {
    // Development starts its own repo-source daemon from `workspace_ensure`.
    // Never run `taco install` from a debug build: install rewrites and
    // reloads the user's launchd/schtasks service asynchronously, which can
    // evict a release daemon while the WebView is connecting to its socket.
    // Production builds retain the automatic service registration behavior.
    if !should_auto_install_daemon_service(cfg!(debug_assertions)) {
        return Ok(());
    }
    let runtime_dir = match resolve_taco_runtime_dir(app.handle()) {
        Ok(dir) => dir,
        Err(_) => return Ok(()),
    };
    // Force reap BEFORE install: the install flow is about to bounce
    // launchd / schtasks, so any daemon currently holding our runtime
    // dir — even our own, even if its control socket still pings — must
    // die pre-emptively. `reap_previous_daemon` alone preserves an alive
    // own daemon; that would race the service respawn and leave two
    // instances bound to the same socket. `force_reap` is the same path
    // plus an unconditional second-pass terminate on the Alive outcome.
    reap_force_at(&runtime_dir, app.handle());
    let control = control_socket_path(&runtime_dir);
    if control_socket_present(&control) {
        return Ok(());
    }
    let Some(launcher) = resolve_install_launcher(app) else {
        return Ok(());
    };
    let mut cmd = std::process::Command::new(&launcher.program);
    for arg in &launcher.prefix_args {
        cmd.arg(arg);
    }
    cmd.arg("install");
    for (key, value) in &launcher.env {
        cmd.env(key, value);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Best-effort: surface the failure on stderr for `pnpm tauri:dev`
    // users but never block the setup hook on it.
    if let Err(e) = cmd.spawn() {
        eprintln!("taco-desktop: failed to spawn `taco install`: {e}");
    }
    Ok(())
}

/// Probe whether a sidecar daemon is currently bound to the control socket.
///
/// Unix: previously used `Path::exists()`, which could not tell a live
/// listener from a stale socket file left by a crashed daemon. The
/// pre-PR-C install path then skipped registration and the desktop
/// later raced for the same socket. We now actually attempt to connect
/// -- a successful connect proves a listener is bound (file alive);
/// ECONNREFUSED proves the file is stale (caller should reap+reinstall);
/// ENOENT means no daemon has ever run on this $TACO_HOME.
///
/// Windows: named pipes do not leave filesystem entries, so the probe is
/// `OpenOptions::open()` -- succeeds iff a server is bound.
fn control_socket_present(control: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::net::UnixStream;
        if !control.exists() {
            return false;
        }
        match UnixStream::connect(control) {
            Ok(s) => {
                // Drop immediately -- we only need to know a listener exists.
                drop(s);
                true
            }
            Err(_) => false,
        }
    }
    #[cfg(windows)]
    {
        std::fs::OpenOptions::new().read(true).open(control).is_ok()
    }
}

///
/// tauri.conf.json can't branch by platform, so `windows` is empty there and
/// we create the window here. Per platform:
///
/// - **macOS**: `TitleBarStyle::Overlay` + `hidden_title` — the OS draws
///   native rounded corners and native traffic lights (which sit at the
///   top-left, in the ActivityRail's reserved padding). This matches the
///   pre-`decorations:false` look; the custom WindowControls React component
///   is hidden on macOS (see App.tsx).
/// - **Windows / Linux**: `decorations:false` frameless, sharp corners, and
///   the React WindowControls supplies min/max/close buttons at the top-right.
fn build_main_window(app: &tauri::App) -> Result<(), tauri::Error> {
    let builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
        .title("Taco")
        .theme(Some(tauri::Theme::Dark))
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);

    let window = builder.build()?;

    // Close button (or OS close gesture) hides instead of quitting. The
    // OS quit path goes through `RunEvent::ExitRequested` which uses
    // `shutdown_sidecar` for a graceful EOF flush; this handler is
    // strictly the "minimize to dock / tray" gesture. Cloning the handle
    // here is required because the closure must outlive the `app`
    // borrow used to build the window.
    let app_for_close = app.handle().clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(w) = app_for_close.get_webview_window("main") {
                let _ = w.hide();
            }
        }
    });

    Ok(())
}

/// Build the system tray icon with a right-click menu. macOS surfaces
/// it in the menu-bar extras; Windows / Linux pin it to the notification
/// area. Left-click focuses the existing main window (no fresh window —
/// the app is single-instance via the plugin registered in `run`).
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray.show", "Show Taco", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray.quit", "Quit Taco", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;
    let _tray = TrayIconBuilder::with_id("taco-tray")
        .icon(icon)
        .tooltip("Taco")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray.show" => focus_main(app),
            "tray.quit" => {
                EXIT_GATE.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Filter for left-click release: macOS / Windows both emit a
            // Down event on press, and we don't want to refocus twice
            // for a single click. `Up` corresponds to WM_LBUTTONUP on
            // Windows and mouseUp: on macOS.
            if let tauri::tray::TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Unminimize + show + focus the main window. Used by both the
/// single-instance plugin's "second launch" callback and the tray
/// icon's left-click handler so they share one definition of "bring
/// the window back".
fn focus_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn run() {
    // First statement: fixes the zero point for every boot offset and opens
    // <TACO_HOME>/logs/boot.log before any phase can stall.
    boot_trace::init();
    boot_trace::mark_rust("run.enter");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch of the UI: surface the existing window instead of
            // spinning up a duplicate process.
            focus_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .setup(|app| {
            // These run SEQUENTIALLY on the setup thread, and
            // prewarm_daemon (which starts the daemon) is last — so anything
            // that blocks in an earlier phase delays the daemon spawn while
            // the window is already visible. Timing each phase separately is
            // what makes that visible.
            boot_trace::mark_rust("setup.enter");
            {
                let _p = boot_trace::Phase::new("setup.build_main_window");
                build_main_window(app)?;
            }
            {
                let _p = boot_trace::Phase::new("setup.build_tray");
                build_tray(app)?;
            }
            {
                let _p = boot_trace::Phase::new("setup.ensure_daemon_installed");
                ensure_daemon_installed(app)?;
            }
            {
                // Reap BEFORE the prewarm dispatch, not in the spawn path
                // it shares with the UI. A stale daemon's SIGTERM grace
                // (≤3s) plus the unlink race used to land on the critical
                // path of the first workspace_ensure; doing it here lets the
                // grace overlap with build_main_window + webview load
                // (≈600ms each), which is what the UI is doing anyway.
                let _p = boot_trace::Phase::new("setup.preemptive_reap");
                if let Ok(runtime_dir) = resolve_taco_runtime_dir(app.handle()) {
                    reap_stale_at(&runtime_dir, app.handle());
                }
            }
            {
                let _p = boot_trace::Phase::new("setup.prewarm_daemon_dispatch");
                prewarm_daemon(app.handle());
            }
            boot_trace::mark_rust("setup.done");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace_ensure,
            workspace_send,
            workspace_dispose_all,
            set_fs_scope,
            desktop_config_read,
            desktop_config_write,
            default_workspace_dir,
            paths_are_dirs,
            boot_mark,
            crate::upgrade_commands::upgrade_marker_present,
            crate::upgrade_commands::upgrade_apply,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        // Tauri sets the dev dock icon from icon.icns during this same event;
        // overriding here lands after it.
        #[cfg(all(target_os = "macos", debug_assertions))]
        tauri::RunEvent::Ready => apply_dev_dock_icon(),
        tauri::RunEvent::ExitRequested { api, .. } => {
            // The second ExitRequested fires after `h.exit(0)` below; the
            // gate flips on the first call so the second one falls through
            // and the process actually terminates.
            if EXIT_GATE.swap(true, Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            let h = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                shutdown_sidecar(&h).await;
                h.exit(0);
            });
        }
        // macOS: the close gesture hides the window instead of destroying it
        // (tray-resident), so the process stays alive and the dock icon keeps
        // its "running" dot. Clicking that icon with no visible windows fires
        // Reopen — with no handler the window stays hidden and the app looks
        // unrecoverable. Bring the hidden window back.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                focus_main(app_handle);
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::PASSTHROUGH_ENV;

    #[test]
    fn service_management_is_disabled_for_debug_builds_only() {
        assert!(!super::should_auto_install_daemon_service(true));
        assert!(super::should_auto_install_daemon_service(false));
    }

    /// The passthrough whitelist exists to stop parent-process credentials
    /// leaking into the sidecar. Guard it so a future addition can't slip a
    /// credential-bearing var in (the code comment alone is not a guardrail).
    #[test]
    fn passthrough_env_carries_no_credential_names() {
        for name in PASSTHROUGH_ENV {
            for marker in ["KEY", "SECRET", "PASSWORD", "TOKEN"] {
                assert!(
                    !name.contains(marker),
                    "PASSTHROUGH_ENV entry `{name}` looks like a credential ({marker})"
                );
            }
        }
    }

    /// NODE_OPTIONS must never reach the sidecar from a release build: it
    /// accepts `--require`, so forwarding it turns the desktop's environment
    /// into an arbitrary-code-injection channel against the daemon. The
    /// unconditional list is the one compiled into release, so the guarantee is
    /// exactly "NODE_OPTIONS is absent from PASSTHROUGH_ENV" — asserted here so
    /// a future edit cannot quietly promote it out of the debug-only list.
    #[test]
    fn node_options_is_never_unconditionally_forwarded() {
        assert!(
            !PASSTHROUGH_ENV.contains(&"NODE_OPTIONS"),
            "NODE_OPTIONS must stay in DEBUG_ONLY_PASSTHROUGH_ENV; forwarding it \
             unconditionally would let the parent environment inject code into \
             the sidecar in release builds"
        );
    }

    /// Counterpart to the above: in debug builds the var *is* expected to be
    /// forwarded, because that is the only route a V8 diagnostic flag has to the
    /// process that actually crashes.
    #[cfg(debug_assertions)]
    #[test]
    fn node_options_is_forwarded_in_debug_builds() {
        assert!(
            super::DEBUG_ONLY_PASSTHROUGH_ENV.contains(&"NODE_OPTIONS"),
            "debug builds must forward NODE_OPTIONS so heap-diagnostic flags reach the daemon"
        );
    }

    /// A listener that accepts and then answers one line per connection, i.e.
    /// a healthy daemon as far as the liveness probe can tell.
    #[cfg(unix)]
    fn spawn_replying_listener(path: std::path::PathBuf) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let listener = tokio::net::UnixListener::bind(&path).unwrap();
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
                    let mut line = String::new();
                    let (r, mut w) = sock.split();
                    if BufReader::new(r).read_line(&mut line).await.is_ok() {
                        let _ = w.write_all(b"{\"id\":\"x\",\"ok\":false}\n").await;
                    }
                });
            }
        })
    }

    /// The regression this probe exists for: a listener that accepts the
    /// connection and then never answers. `connect()` succeeds against it, so
    /// the old connect-only check reported "ready" and the caller installed a
    /// daemon that could not serve a single RPC.
    #[cfg(unix)]
    fn spawn_silent_listener(path: std::path::PathBuf) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let listener = tokio::net::UnixListener::bind(&path).unwrap();
            let mut held = Vec::new();
            loop {
                let Ok((sock, _)) = listener.accept().await else {
                    return;
                };
                // Hold the socket open: dropping it would send EOF, which the
                // probe correctly reports as a failure for a different reason.
                held.push(sock);
            }
        })
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn wait_for_daemon_socket_accepts_a_daemon_that_answers() {
        let dir = std::env::temp_dir().join(format!("taco-probe-ok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("sidecar.sock");
        let listener = spawn_replying_listener(sock.clone());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let result = super::wait_for_daemon_socket(&sock, std::time::Duration::from_secs(2)).await;
        assert!(result.is_ok(), "a replying daemon must be seen as ready: {result:?}");

        listener.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn wait_for_daemon_socket_rejects_a_bound_but_silent_daemon() {
        let dir = std::env::temp_dir().join(format!("taco-probe-silent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("sidecar.sock");
        let listener = spawn_silent_listener(sock.clone());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Deadline below NDJSON_PROBE_TIMEOUT so the outer loop, not the
        // per-probe timeout, is what gives up — this is the cold-start shape.
        let result = super::wait_for_daemon_socket(&sock, std::time::Duration::from_millis(300))
            .await;
        assert!(
            result.is_err(),
            "a daemon that accepts but never answers must NOT be reported ready"
        );
        assert!(
            sock.exists(),
            "the socket has a live owner; the probe must not unlink it"
        );

        listener.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn wait_for_daemon_socket_reports_an_absent_socket() {
        let dir = std::env::temp_dir().join(format!("taco-probe-absent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("sidecar.sock");

        let result = super::wait_for_daemon_socket(&sock, std::time::Duration::from_millis(200))
            .await;
        assert!(result.is_err(), "no listener at all must fail");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
