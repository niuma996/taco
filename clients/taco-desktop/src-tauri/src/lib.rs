/*!
 * Tauri 2 entry — spawn sidecar + 暴露给 React 端的 invoke commands
 *
 * 关键设计:
 *  - 全进程共享**一个** sidecar 子进程,Rust 只负责进程生死 + stdio 字节管道
 *  - sidecar 自身按 `params.workspace` 路由并懒建 WorkspaceRuntime(见 server.ts
 *    的 workspaceMap),所以多 workspace 无需多进程
 *  - Rust 不解析协议帧:stdout 每行原样转发为 Tauri event `sidecar-event {line}`,
 *    「这帧属于哪个 workspace」由前端 dispatcher 从帧内字段判定
 *  - 客户端 (React) 调 invoke('workspace_send', { cwd, line: JSON.stringify(req) })
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
use tokio::sync::{mpsc, oneshot, Mutex};

pub mod log_file;
pub use log_file::LogFiles;

mod paths;
mod sidecar_launcher;
mod daemon_reap;
/// Test-only re-exports for the daemon_reap integration test under
/// `tests/daemon_reap.rs`. Hidden from the public docs because the
/// symbols are crate-internal helpers, not a stable API.
#[doc(hidden)]
pub mod daemon_reap_test {
    pub use crate::daemon_reap::__test_only::*;
}
pub mod upgrade_commands;

use crate::paths::{control_socket_path, find_repo_root, normalize_cwd, resolve_taco_home};
use crate::sidecar_launcher::{resolve_install_launcher, resolve_sidecar, PASSTHROUGH_ENV};

/// Gate that lets a programmatic `AppHandle::exit` pass through without
/// re-entering the shutdown helper. The OS-driven `RunEvent::ExitRequested`
/// (Cmd+Q / window manager close on Windows/Linux) calls `prevent_exit`,
/// runs the sidecar teardown, then `exit(0)` triggers a second ExitRequested.
/// Swapping the gate from false → true on the first event marks the second
/// one as "already handled" so it falls through and the process actually
/// terminates.
static EXIT_GATE: AtomicBool = AtomicBool::new(false);


/// 默认 workspace 的绝对路径,并保证目录存在。
///
/// 曾经硬编码为 `/tmp/taco-demo`,但 macOS 会定期清理 `/tmp`,而且这个目录
/// 从来没人创建过 —— 首次启动就指向一个不存在的路径。sidecar 把它当
/// stdio MCP server 的默认 cwd,spawn 便以「command ENOENT」的名义失败,
/// 报错完全指不到真因。放到 TACO_HOME 下并在这里 mkdir,两个问题一起消失。
#[tauri::command]
async fn default_workspace_dir(app: AppHandle) -> Result<String, String> {
    let dir = resolve_taco_home(&app)?.join("workspace");
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("failed to create default workspace dir: {e}"))?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// 批量判断路径是否为存在的目录,顺序与入参一一对应。
///
/// 前端据此剔除已失效的历史 workspace(目录被移动 / 删除 / `/tmp` 被清理)。
/// 走 Rust 而不是前端 fs plugin:待检查的路径不在 fs scope 里,plugin 会直接
/// 拒绝,而这里只读元数据、不读内容。
#[tauri::command]
async fn paths_are_dirs(paths: Vec<String>) -> Result<Vec<bool>, String> {
    Ok(paths
        .into_iter()
        .map(|p| std::path::Path::new(&p).is_dir())
        .collect())
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
    /// 唯一共享 sidecar 进程。锁仅在 install / dispose 路径持;spawn 在锁外执行
    /// —— 这样 dispose 期间可以 acquire 锁、设 shutdown flag,ensure 在 install
    /// 前能看到这个 flag,杀掉孤儿进程而非被 dispose race-kill 后留个 zombie。
    pub sidecar: Mutex<Option<SharedSidecar>>,
    next_process_generation: AtomicU64,
    /// dispose 期间为 true —— ensure 在 spawn 前后都会检查,避免在 dispose 之后
    /// install 一个马上被杀的进程(orphan)。
    shutdown_initiated: AtomicBool,
    /// Per-process log file family, set when a sidecar is installed. None
    /// before the first install; recreated on each new sidecar process so the
    /// file's lifetime matches the process lifetime — simpler reasoning, and
    /// a restart produces a fresh file rather than appending to one from a
    /// now-dead process.
    ///
    /// The reader task gets a clone of the inner `Arc` at install time (see
    /// `workspace_ensure`), so it can outlive the slot install without
    /// holding the Tauri State — and so a parallel aborting ensure never
    /// shares a handle with the winning one.
    ///
    /// The double-Arc is load-bearing: the outer one is the install-publish
    /// point (one writer at a time, behind a synchronous mutex since
    /// Tauri `State<T>` only `Deref`s to `T`); the inner one is the handle
    /// each reader owns, so its lifetime isn't tied to the publish point.
    pub log_files: Arc<StdMutex<Option<Arc<StdMutex<LogFiles>>>>>,
    /// JoinHandle of the running stderr reader task. A restart joins the prior
    /// generation's reader before opening the log files: the reader's final
    /// `flush` can itself trip a rotation (the rename chain), and two readers
    /// holding independent `LogFiles` mutexes on the same fixed paths would
    /// race those renames.
    pub stderr_reader: StdMutex<Option<tokio::task::JoinHandle<()>>>,
    /// First stdout line of the current sidecar, tagged with its generation so a
    /// losing concurrent spawn can't publish its own. `workspace_ensure` hands it
    /// back to a client that attached after spawn — Tauri events have no replay,
    /// and the sidecar's handshake is one-shot. Rust does not interpret the line;
    /// the client validates it.
    pub handshake_line: StdMutex<Option<(u64, String)>>,
    /// Serializes the whole workspace_ensure sequence (spawn → connect → hello
    /// wait). Without it, N concurrent first-start callers each spawn their own
    /// launcher, and every caller that loses the slot race reads an empty
    /// `handshake_line` and returns None — the frontend then waits for a hello
    /// the reader never re-emits as `sidecar-event`, a guaranteed 10s
    /// "sidecar hello timeout". Under the lock, a later caller always observes
    /// a consistent state: no slot, or slot + stored handshake.
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
            handshake_line: StdMutex::new(None),
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
        let client = tokio::net::windows::named_pipe::NamedPipeClient::open(path)
            .map_err(|e| format!("named pipe open {} failed: {e}", path.display()))?;
        client
            .connect()
            .await
            .map_err(|e| format!("named pipe connect {} failed: {e}", path.display()))?;
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

/// Poll the daemon socket (with backoff) until a connection attempt succeeds
/// or the deadline expires. Mirrors packages/cli/lib/start.ts `waitForSocket`
/// so the launcher and the desktop agree on the "ready" heuristic.
///
/// On the first failure we proactively clear any stale socket file the same
/// way the sidecar's own startup probe does (see packages/sidecar/src/index.ts
/// `probeNdjsonSocket`). Without this, a previously-crashed daemon's socket
/// file would let `connect()` succeed against a ghost listener — the very next
/// NDJSON read sees EOF and the UI stalls silently. Once the stale file is
/// removed the launcher can rebind.
async fn wait_for_daemon_socket(path: &std::path::Path, timeout: Duration) -> Result<(), String> {
    let probe_interval = Duration::from_millis(50);
    let deadline = tokio::time::Instant::now() + timeout;
    let mut stale_checked = false;
    loop {
        match connect_daemon_socket(path).await {
            Ok(_conn) => return Ok(()),
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

/// 确保共享 sidecar 进程存在。首次调用 spawn,后续任意 cwd 直接返回 —— sidecar
/// 会在收到带 `params.workspace` 的 RPC 时自行懒建 WorkspaceRuntime,Rust 无需
/// 为新 workspace 做任何事。
///
/// `cwd` 仅在首次 spawn 时用于决定 repo-source 模式的工作目录;`debug_mode` 同样
/// 只在首次生效(spawn-time env)。持锁跨 await 保证并发调用不会双 spawn。
///
/// 返回值:进程已在运行时返回它 spawn 后的第一行 stdout(否则 None)。sidecar 的
/// 握手帧只在启动时发一次,而 Tauri event 无重放 —— 一个在那之后才注册监听的
/// client(webview 重载 / 组件树重建)否则永远等不到它。Rust 不解析这行的语义,
/// 由前端判定是否为握手帧。
#[tauri::command]
async fn workspace_ensure(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    debug_mode: Option<bool>,
    llm_dump_to_file: Option<bool>,
) -> Result<Option<String>, String> {
    let _ = cwd;
    let _ = debug_mode;
    let _ = llm_dump_to_file;

    // Single-flight: serialize the whole ensure so concurrent first-starts
    // can't race the slot/handshake window (see ensure_lock on AppState).
    let _ensure_guard = state.ensure_lock.lock().await;

    // 第一道关:已存在共享连接或 dispose 已发起 → 不 spawn。
    {
        let slot = state.sidecar.lock().await;
        if let Some(existing) = slot.as_ref() {
            let line = state
                .handshake_line
                .lock()
                .unwrap()
                .as_ref()
                .filter(|(generation, _)| *generation == existing.generation)
                .map(|(_, line)| line.clone());
            return Ok(line);
        }
        if state.shutdown_initiated.load(Ordering::Acquire) {
            return Err("sidecar shutting down".into());
        }
    }

    // 第二道关（PR-C）:进 spawn 之前先 reap 磁盘上的残留 daemon。
    //   - 没有 pid 文件 → 无事可做
    //   - pid 文件的 install_id 不匹配 → 别的安装的 daemon，**不能**碰
    //   - pid 文件的进程还活着但 ping 不通（PID 回收 / 进程 hang）→ 杀
    //   - pid 文件的进程死了（stale）→ unlink，让 spawn 重新 bind
    // 在 ensure_lock 内做，避免 reap 与并发 ensure 互相打架。
    #[cfg(unix)]
    {
        if let Ok(taco_home) = resolve_taco_home(&app) {
            reap_stale_at(&taco_home, &app);
        }
    }

    let resolution = resolve_sidecar(&app)?;
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
    // real cause in the terminal and the UI saw a generic "sidecar hello
    // timeout" after the 5s socket-wait elapsed. The buf is capped at 4 KiB so
    // a chatty daemon cannot grow it without bound.
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());

    cmd.env_clear();
    for key in PASSTHROUGH_ENV {
        if let Ok(v) = std::env::var(key) {
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

    let mut launcher = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar launcher: {e}"))?;
    let generation = state.next_process_generation.fetch_add(1, Ordering::Relaxed);

    // Drain the launcher's stderr into stderr_buf (capped at 4 KiB). Kept
    // alive for the lifetime of the function so a fast-exiting launcher can
    // still surface its last few lines before we read the buffer.
    let stderr_buf: std::sync::Arc<std::sync::Mutex<Vec<u8>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::with_capacity(4096)));
    if let Some(mut stderr) = launcher.stderr.take() {
        let buf = std::sync::Arc::clone(&stderr_buf);
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut tmp = [0u8; 1024];
            // Fill a local buffer first, then commit under a short lock.
            // This avoids holding the MutexGuard across `await` points, which
            // would make the future !Send.
            let mut local: Vec<u8> = Vec::with_capacity(4096);
            loop {
                match stderr.read(&mut tmp).await {
                    Ok(0) => break,
                    Ok(n) => {
                        if local.len() + n > 4096 {
                            let take = 4096 - local.len();
                            local.extend_from_slice(&tmp[..take]);
                            // Drain the rest to keep the pipe from blocking.
                            let mut discard = [0u8; 1024];
                            while let Ok(n) = stderr.read(&mut discard).await {
                                if n == 0 {
                                    break;
                                }
                            }
                            break;
                        }
                        local.extend_from_slice(&tmp[..n]);
                    }
                    Err(_) => break,
                }
            }
            if !local.is_empty() {
                let mut g = buf.lock().unwrap();
                if g.len() < 4096 {
                    let take = (4096 - g.len()).min(local.len());
                    g.extend_from_slice(&local[..take]);
                }
            }
        });
    }

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

    let conn = connect_daemon_socket(&socket_path).await?;
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

    // Reader task: NDJSON frames from the socket are forwarded to the
    // frontend as `sidecar-event`; the first frame is also captured as the
    // handshake line so late ensure() callers can re-read it.
    //
    // The daemon's hello is that one-shot first frame, and the reader does NOT
    // re-emit it as a `sidecar-event` (it goes into `handshake_line` instead).
    // So the spawning caller has no other way to observe it — hand it back over
    // a oneshot so this ensure() returns the same handshake a reconnect would
    // read out of `handshake_line`. Returning `None` here (the pre-fix shape)
    // left the frontend's hello wait with no source and it could only time out.
    let (hello_tx, hello_rx) = oneshot::channel::<String>();
    let app_for_reader = app.clone();
    let reader_handle = tokio::spawn(async move {
        let mut hello_tx = Some(hello_tx);
        let mut reader = BufReader::new(&mut read_half).lines();
        let mut first_line_seen = false;
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    if !first_line_seen {
                        first_line_seen = true;
                        // app.state() returns a State<'_, T> that's a
                        // deref to AppState; bind it so the lock guard
                        // lives long enough.
                        let state = app_for_reader.state::<AppState>();
                        *state.handshake_line.lock().unwrap() =
                            Some((generation, line.clone()));
                        if let Some(tx) = hello_tx.take() {
                            let _ = tx.send(line.clone());
                        }
                    } else {
                        let _ = app_for_reader.emit(
                            "sidecar-event",
                            serde_json::json!({ "line": line }),
                        );
                    }
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
            let _ = app_for_reader.emit(
                "sidecar-exited",
                serde_json::json!({ "code": null }),
            );
        }
    });

    // PR2 does NOT publish state.log_files — the daemon writes its own logs
    // (PR3 wires LogFiles inside the bundle). The fields stay on AppState
    // for the install_publish test, but are left as None for daemon installs.
    *state.log_files.lock().unwrap() = None;

    // 第三道关:install 前再查 shutdown flag 与 slot —— 若 dispose 在 spawn 期间
    // 被触发、或另一个并发 ensure 已经 install,杀掉刚 spawn 的孤儿 launcher。
    let mut slot = state.sidecar.lock().await;
    if state.shutdown_initiated.load(Ordering::Acquire) {
        drop(tx);
        launcher.kill().await.ok();
        launcher.wait().await.ok();
        std::mem::drop(reader_handle);
        return Err("sidecar shutting down".into());
    }
    if let Some(existing) = slot.as_ref() {
        drop(tx);
        launcher.kill().await.ok();
        launcher.wait().await.ok();
        std::mem::drop(reader_handle);
        let line = state
            .handshake_line
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(generation, _)| *generation == existing.generation)
            .map(|(_, line)| line.clone());
        return Ok(line);
    }

    *slot = Some(SharedSidecar {
        stdin_tx: tx,
        launcher: Some(launcher),
        generation,
    });
    // Release the slot lock before awaiting the hello so concurrent ensure()
    // callers aren't serialized behind it (the hello normally lands in ms).
    drop(slot);

    // Await the one-shot hello the reader captured from the daemon's first
    // frame. On failure tear the slot down — a poisoned entry (connected but no
    // hello) would wedge every later ensure() on a handshake that never comes,
    // so force the next call to respawn against a fresh daemon instead.
    match tokio::time::timeout(Duration::from_secs(5), hello_rx).await {
        Ok(Ok(line)) => Ok(Some(line)),
        Ok(Err(_)) | Err(_) => {
            let mut slot = state.sidecar.lock().await;
            if let Some(s) = slot.take() {
                drop(s.stdin_tx);
                if let Some(mut l) = s.launcher {
                    let _ = l.kill().await;
                    let _ = l.wait().await;
                }
            }
            Err("sidecar connected but sent no hello within 5s".into())
        }
    }
}

/// 所有 workspace 共用一条 stdin —— `cwd` 保留仅为 API 兼容,不参与路由。
/// 请求体自带 `params.workspace`,由 sidecar 侧路由。
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

/// 杀掉共享 sidecar 进程 —— 前端 `client.dispose()` / restartSidecar 的落点。
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
    // 在 acquire 锁之前先 set flag —— 让任何正在进行的 ensure(第一道关内已过、
    // 第二段 spawn 中的)在 install 前能看到 flag,从而杀掉孤儿 launcher 而非被
    // race-kill 留个 zombie。Reset 在锁外:典型路径是 dispose → 重新 ensure
    // (restartSidecar),reset 后下一次 ensure 能正常 spawn。
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
        // TACO_HOME just means we skip the control.shutdown step and
        // fall through to the reap path.
        let control_path = resolve_taco_home(app)
            .ok()
            .map(|h| control_socket_path(&h));
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
        }
        #[cfg(unix)]
        {
            // Reap covers the dev-mode orphan (CLI launcher already
            // exited; daemon detached and unreachable via launcher
            // handle) AND the rare prod case where the daemon is
            // wedged and ignored control.shutdown. Idempotent: a
            // missing pid file is a no-op.
            if let Ok(home) = resolve_taco_home(app) {
                reap_stale_at(&home, app);
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

/// Send `control.shutdown` to the daemon's control socket and read the
/// ack. Returns Ok if the daemon responded within the caller's timeout;
/// any error means "didn't ack in time" and the caller should fall
/// through to reap/kill.
async fn send_control_shutdown(path: std::path::PathBuf) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;
    #[cfg(unix)]
    {
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

#[cfg(unix)]
fn reap_stale_at(taco_home: &std::path::Path, app: &tauri::AppHandle) {
    use crate::daemon_reap::{
        compute_install_id, daemon_paths, reap_previous_daemon, ReapInputs,
    };
    let (pid_file, socket_path, control_socket_path) = daemon_paths(taco_home);
    // Best-effort resources root -- release uses app resource_dir,
    // dev uses the repo source root. Both can be empty if resolution
    // failed; the install_id computation still produces a stable value
    // and reap can still proceed (any non-matching id means "leave it
    // alone" which is the safe default for foreign daemons).
    let resources_root = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p.join("sidecar").to_string_lossy().into_owned())
        .or_else(|| {
            let root = find_repo_root();
            Some(root.join("packages").join("sidecar").join("src").to_string_lossy().into_owned())
        })
        .unwrap_or_default();
    let own_install_id =
        compute_install_id(&resources_root, &taco_home.to_string_lossy());
    let inputs = ReapInputs {
        pid_file,
        socket_path,
        control_socket_path,
        own_install_id: &own_install_id,
        resources_root: std::path::PathBuf::from(&resources_root),
    };
    let outcome = reap_previous_daemon(&inputs);
    // Best-effort log only -- never block setup on a reap that finds
    // nothing. Operators see this in `pnpm tauri:dev` stderr.
    eprintln!("taco-desktop: reap outcome = {:?}", outcome);
}

/// Auto-register the sidecar as an OS-level service on first run.
/// Registration is best-effort so startup remains available when a platform
/// launcher or optional service manager is unavailable.
fn ensure_daemon_installed(app: &tauri::App) -> tauri::Result<()> {
    let taco_home = match resolve_taco_home(app.handle()) {
        Ok(h) => h,
        Err(_) => return Ok(()),
    };
    let control = control_socket_path(&taco_home);
    if control_socket_present(&control) {
        return Ok(());
    }
    // Reap any stale daemon before installing the launchd/schtasks
    // service. Without this, a previously-killed daemon could leave a
    // pid file + socket file behind; the freshly-loaded plist would
    // then race the install probe for the same control socket and
    // launchd would either bounce (Crashed=true) or skip the spawn
    // entirely depending on the timing. Idempotent on Unix; Windows
    // is a no-op since pid files aren't written there.
    #[cfg(unix)]
    {
        reap_stale_at(&taco_home, app.handle());
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
        std::fs::OpenOptions::new()
            .read(true)
            .open(control)
            .is_ok()
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
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::default(),
    )
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
            build_main_window(app)?;
            build_tray(app)?;
            ensure_daemon_installed(app)?;
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
            crate::upgrade_commands::upgrade_marker_present,
            crate::upgrade_commands::upgrade_apply,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
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
        tauri::RunEvent::Reopen { has_visible_windows, .. } => {
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
}

