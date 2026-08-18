//! Tauri-side path helpers — `TACO_HOME` resolution, socket paths, repo-root
//! discovery, Windows verbatim-prefix stripping. Pure functions on `Path` /
//! `PathBuf` plus one `AppHandle`-rooted helper (`resolve_taco_home`). Kept
//! separate from `lib.rs`'s Tauri command layer so the path logic can be
//! reasoned about without the workspace-command noise.

use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Strip the Windows verbatim prefix (`\\?\`). `current_exe()` and
/// `resource_dir()` on Windows may return paths of that shape; Rust's own
/// `std::fs` handles them, but passing them as argv to a child breaks Node's
/// `realpath` (it interprets `\\?\D:` as a directory and crashes the sidecar
/// with `EISDIR`). Strip once before the value crosses a `Command`.
pub(crate) fn strip_win_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p.to_path_buf(),
    }
}

/// NDJSON socket path. Unix: filesystem path under `$TACO_HOME/run/`.
/// Windows: named pipe `\\.\pipe\taco-sidecar`. Mirrors
/// `packages/cli/lib/paths.ts` so the @taco-ai/cli launcher and the desktop
/// agree on the path without an IPC roundtrip.
pub(crate) fn ndjson_socket_path(home: &Path) -> PathBuf {
    if cfg!(windows) {
        return PathBuf::from(r"\\.\pipe\taco-sidecar");
    }
    home.join("run").join("sidecar.sock")
}

/// Control socket path. Same shape as `ndjson_socket_path` but with a
/// distinct name so a single-instance check can detect an existing daemon
/// via bind-with-O_EXCL on this path without colliding with the data
/// channel.
pub(crate) fn control_socket_path(home: &Path) -> PathBuf {
    if cfg!(windows) {
        return PathBuf::from(r"\\.\pipe\taco-sidecar-ctl");
    }
    home.join("run").join("sidecar-ctl.sock")
}

/// taco 自有路径的根:TACO_HOME env > $HOME/.taco。
///
/// 返回值恒为**绝对路径**,并且是唯一的真相来源 —— desktop.json 和传给
/// sidecar 子进程的 TACO_HOME 都用它,两侧不可能再分叉。
///
/// 为什么必须绝对化:相对值(如 `TACO_HOME=state`)在两个进程里基准不同 ——
/// 桌面端按 Tauri 主进程 cwd 解析,而 repo-source 形态下 sidecar 的 cwd 被
/// 显式设为 repo_root。结果 desktop.json 落在一处、sessions 落在另一处,
/// 表面上"都用了 TACO_HOME"却指向不同目录。
///
/// 空白值(`""` / `"   "`)视同未设:它解析不出有意义的路径,回退比让两侧
/// 各自猜更安全。sidecar 侧 `config/tacoHome.ts` 同步了同一套规则。
pub(crate) fn resolve_taco_home(app: &AppHandle) -> Result<PathBuf, String> {
    let raw = match std::env::var("TACO_HOME") {
        Ok(v) if !v.trim().is_empty() => Some(PathBuf::from(v.trim())),
        _ => None,
    };
    let taco_home = match raw {
        Some(p) if p.is_absolute() => p,
        // 相对路径按主进程 cwd 绝对化,随后同一个绝对值透传给 sidecar。
        Some(p) => std::env::current_dir()
            .map_err(|e| format!("cwd unavailable while resolving TACO_HOME: {e}"))?
            .join(p),
        None => app
            .path()
            .home_dir()
            .map_err(|e| format!("home_dir unavailable: {e}"))?
            .join(".taco"),
    };
    if !taco_home.exists() {
        std::fs::create_dir_all(&taco_home)
            .map_err(|e| format!("failed to create .taco: {e}"))?;
    }
    Ok(taco_home)
}

#[cfg(windows)]
const SIDECAR_PROGRAM_FILENAME: &str = "tsx.cmd";
#[cfg(not(windows))]
const SIDECAR_PROGRAM_FILENAME: &str = "tsx";

/// Resolve the sidecar launcher in repo-source (debug) mode.
///
/// On Windows `Command::new("tsx")` does not consult PATHEXT, so a bare
/// `tsx` lookup fails with "program not found" even when `tsx.cmd` sits
/// right next to it in `node_modules/.bin`. Prefer the workspace-local
/// copy pnpm installs; fall back to the bare name so a globally-installed
/// tsx still works.
pub(crate) fn resolve_repo_source_program(repo_root: &Path) -> String {
    let local = repo_root
        .join("node_modules")
        .join(".bin")
        .join(SIDECAR_PROGRAM_FILENAME);
    if local.exists() {
        return local.to_string_lossy().into_owned();
    }
    SIDECAR_PROGRAM_FILENAME.to_string()
}

/// 从当前可执行文件向上扫描,找到含 `pnpm-workspace.yaml` 的目录作为 repo root。
/// 跨 `cargo run` / `pnpm tauri:dev` / release `.app` bundle 都稳。
pub(crate) fn find_repo_root() -> PathBuf {
    let start = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let mut current = start;
    loop {
        if current.join("pnpm-workspace.yaml").exists() {
            return current;
        }
        match current.parent() {
            Some(p) => current = p.to_path_buf(),
            None => return current,
        }
    }
}

/// Lexically normalize: 解析 `.` / `..` 但不要求路径存在(无 fs 访问)。
/// 与 Node 端 `path.resolve` 行为一致,这是 WorkspaceRuntime 用于 routing key 的语义。
pub(crate) fn cleanpath(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {} // skip .
            Component::ParentDir => {
                // pop only if there's a real prefix / normal component to pop
                if matches!(
                    out.components().next_back(),
                    Some(Component::Normal(_)) | Some(Component::Prefix(_))
                ) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

pub(crate) fn normalize_cwd(cwd: &str) -> String {
    // 与 sidecar 端 WorkspaceRuntime 行为对齐:
    //   1. trim 尾部 /
    //   2. 相对路径以 current_dir 兜底拼成绝对路径
    //   3. 解析 . / .. 段(无需路径存在,允许预先注册尚未创建的 workspace)
    let trimmed = cwd.trim_end_matches('/');
    let p = Path::new(trimmed);
    let absolute: PathBuf = if p.is_absolute() {
        p.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(p),
            Err(_) => p.to_path_buf(),
        }
    };
    cleanpath(&absolute).to_string_lossy().into_owned()
}