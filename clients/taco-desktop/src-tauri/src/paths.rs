//! Tauri-side path helpers — `TACO_HOME` resolution, socket paths, repo-root
//! discovery, Windows verbatim-prefix stripping. Pure functions on `Path` /
//! `PathBuf` plus one `AppHandle`-rooted helper (`resolve_taco_home`). Kept
//! separate from `lib.rs`'s Tauri command layer so the path logic can be
//! reasoned about without the workspace-command noise.

use sha2::{Digest, Sha256};
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

/// Hash a runtime directory into the 16-hex slug used in Windows pipe names.
///
/// Must stay in lockstep with `packages/cli/lib/paths.ts::windowsPipeSlug` —
/// the sidecar is a separate process that derives the same pipe name on its
/// own: slash direction is folded first, then the `\\?\` prefix is dropped,
/// then trailing separators are trimmed, then the case fold is **ASCII-only**
/// (`make_ascii_lowercase`, *not* `str::to_lowercase`, which would split
/// `C:\Users\Ü…` from the TS side's `[A-Z]`-only fold).
pub(crate) fn windows_pipe_slug(runtime_dir: &Path) -> String {
    let slashed = runtime_dir.to_string_lossy().replace('/', "\\");
    let mut normalized = strip_win_verbatim(Path::new(&slashed))
        .to_string_lossy()
        .into_owned();
    while normalized.ends_with('\\') {
        normalized.pop();
    }
    normalized.make_ascii_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// NDJSON socket path. Unix: filesystem path under the resolved runtime
/// directory. Windows: named pipe derived from the runtime directory so
/// debug (`~/.taco-dev/run`) and release (`~/.taco/run`) do not collide.
/// Mirrors `packages/cli/lib/paths.ts` so the @taco-ai/cli launcher and the
/// desktop agree on the path without an IPC roundtrip.
pub(crate) fn ndjson_socket_path(runtime_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        return PathBuf::from(format!(
            r"\\.\pipe\taco-sidecar-{}",
            windows_pipe_slug(runtime_dir)
        ));
    }
    runtime_dir.join("sidecar.sock")
}

/// Control socket path. Same shape as `ndjson_socket_path` but with a
/// distinct name so a single-instance check can detect an existing daemon
/// via bind-with-O_EXCL on this path without colliding with the data
/// channel.
pub(crate) fn control_socket_path(runtime_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        return PathBuf::from(format!(
            r"\\.\pipe\taco-sidecar-ctl-{}",
            windows_pipe_slug(runtime_dir)
        ));
    }
    runtime_dir.join("sidecar-ctl.sock")
}

/// Resolve Taco's shared user-data root. An explicit `TACO_HOME` always wins;
/// otherwise both debug and release builds use `~/.taco`. The desktop passes
/// this absolute value to the sidecar so desktop settings, configuration, and
/// sessions remain shared even when daemon runtime state is isolated.
///
/// Relative values are resolved from the desktop process cwd before passing
/// them to the sidecar, whose repo-source debug cwd differs from Tauri's cwd.
/// Blank values (`""` / `"   "`) are treated as unset.
pub(crate) fn default_taco_home(home_dir: &Path) -> PathBuf {
    home_dir.join(".taco")
}

/// Resolve a `TACO_HOME` value without touching the filesystem. Keeping this
/// policy pure makes shared configuration behavior straightforward to test.
pub(crate) fn resolve_taco_home_value(
    raw: Option<&str>,
    home_dir: &Path,
    current_dir: &Path,
) -> PathBuf {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                current_dir.join(path)
            }
        }
        None => default_taco_home(home_dir),
    }
}

/// Resolve the directory that owns daemon sockets, pid files, and start locks.
/// Release uses `<TACO_HOME>/run`. Debug uses `~/.taco-dev/run` for the default
/// profile and `<explicit TACO_HOME>/.run-dev` for an explicit profile.
pub(crate) fn resolve_taco_runtime_dir_value(
    raw: Option<&str>,
    home_dir: &Path,
    current_dir: &Path,
    debug: bool,
) -> PathBuf {
    let taco_home = resolve_taco_home_value(raw, home_dir, current_dir);
    if !debug {
        return taco_home.join("run");
    }
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        Some(_) => taco_home.join(".run-dev"),
        None => home_dir.join(".taco-dev").join("run"),
    }
}

fn resolve_path_inputs(app: &AppHandle) -> Result<(Option<String>, PathBuf, PathBuf), String> {
    let home_dir = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir unavailable: {e}"))?;
    let current_dir = std::env::current_dir()
        .map_err(|e| format!("cwd unavailable while resolving TACO_HOME: {e}"))?;
    Ok((std::env::var("TACO_HOME").ok(), home_dir, current_dir))
}

pub(crate) fn resolve_taco_home(app: &AppHandle) -> Result<PathBuf, String> {
    let (raw, home_dir, current_dir) = resolve_path_inputs(app)?;
    let taco_home = resolve_taco_home_value(raw.as_deref(), &home_dir, &current_dir);
    std::fs::create_dir_all(&taco_home).map_err(|e| format!("failed to create TACO_HOME: {e}"))?;
    Ok(taco_home)
}

pub(crate) fn resolve_taco_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let (raw, home_dir, current_dir) = resolve_path_inputs(app)?;
    let runtime_dir = resolve_taco_runtime_dir_value(
        raw.as_deref(),
        &home_dir,
        &current_dir,
        cfg!(debug_assertions),
    );
    std::fs::create_dir_all(&runtime_dir)
        .map_err(|e| format!("failed to create TACO_RUNTIME_DIR: {e}"))?;
    Ok(runtime_dir)
}

#[cfg(test)]
mod tests {
    use super::{default_taco_home, resolve_taco_home_value, resolve_taco_runtime_dir_value};
    use std::path::Path;

    #[test]
    fn default_home_is_shared_between_debug_and_release() {
        let home = Path::new("/Users/test");
        assert_eq!(default_taco_home(home), Path::new("/Users/test/.taco"));
    }

    #[test]
    fn default_runtime_dirs_are_isolated_between_debug_and_release() {
        let home = Path::new("/Users/test");
        assert_eq!(
            resolve_taco_runtime_dir_value(None, home, Path::new("/repo"), true),
            Path::new("/Users/test/.taco-dev/run")
        );
        assert_eq!(
            resolve_taco_runtime_dir_value(None, home, Path::new("/repo"), false),
            Path::new("/Users/test/.taco/run")
        );
    }

    #[test]
    fn explicit_home_is_shared_but_runtime_is_mode_specific() {
        let home = Path::new("/Users/test");
        let cwd = Path::new("/repo");
        let explicit = Some("/profiles/team-a");
        assert_eq!(
            resolve_taco_home_value(explicit, home, cwd),
            Path::new("/profiles/team-a")
        );
        assert_eq!(
            resolve_taco_runtime_dir_value(explicit, home, cwd, true),
            Path::new("/profiles/team-a/.run-dev")
        );
        assert_eq!(
            resolve_taco_runtime_dir_value(explicit, home, cwd, false),
            Path::new("/profiles/team-a/run")
        );
    }

    #[test]
    fn blank_home_uses_shared_home_and_mode_specific_runtime() {
        let home = Path::new("/Users/test");
        let cwd = Path::new("/repo");
        assert_eq!(
            resolve_taco_home_value(Some(""), home, cwd),
            Path::new("/Users/test/.taco")
        );
        assert_eq!(
            resolve_taco_runtime_dir_value(Some("  "), home, cwd, true),
            Path::new("/Users/test/.taco-dev/run")
        );
    }

    #[test]
    fn relative_explicit_home_is_resolved_from_desktop_cwd() {
        let home = Path::new("/Users/test");
        let cwd = Path::new("/repo");
        assert_eq!(
            resolve_taco_home_value(Some("state"), home, cwd),
            Path::new("/repo/state")
        );
        assert_eq!(
            resolve_taco_runtime_dir_value(Some("state"), home, cwd, true),
            Path::new("/repo/state/.run-dev")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_pipe_names_are_scoped_to_the_runtime_directory() {
        use super::{control_socket_path, ndjson_socket_path, windows_pipe_slug};
        let debug = Path::new(r"C:\Users\test\.taco-dev\run");
        let release = Path::new(r"C:\Users\test\.taco\run");
        assert_eq!(windows_pipe_slug(debug), "3046aa052e73dbd5");
        assert_eq!(windows_pipe_slug(release), "09fab001c591f07f");
        assert_ne!(ndjson_socket_path(debug), ndjson_socket_path(release));
        assert_eq!(
            ndjson_socket_path(debug),
            Path::new(r"\\.\pipe\taco-sidecar-3046aa052e73dbd5")
        );
        assert_eq!(
            control_socket_path(debug),
            Path::new(r"\\.\pipe\taco-sidecar-ctl-3046aa052e73dbd5")
        );
        assert_eq!(
            windows_pipe_slug(Path::new(r"c:/Users/test/.taco-dev/run")),
            windows_pipe_slug(debug)
        );
        assert_eq!(
            windows_pipe_slug(Path::new(r"\\?\C:\Users\test\.taco-dev\run")),
            windows_pipe_slug(debug)
        );
        // The forward-slash verbatim form must fold to the backslash one —
        // `windowsPipeSlug` replaces slashes before dropping the prefix.
        assert_eq!(
            windows_pipe_slug(Path::new(r"//?/C:/Users/test/.taco-dev/run")),
            windows_pipe_slug(debug)
        );
        // Case fold is ASCII-only, matching the TS side's `[A-Z]` replace.
        assert_eq!(
            windows_pipe_slug(Path::new(r"C:\Users\ÜNDREA\.taco-dev\run")),
            windows_pipe_slug(Path::new(r"c:\users\ÜNDREA\.taco-dev\run"))
        );
    }
}

#[cfg(windows)]
const NODE_PROGRAM_FILENAME: &str = "node.exe";
#[cfg(not(windows))]
const NODE_PROGRAM_FILENAME: &str = "node";

/// Resolve the program that runs `packages/cli/bin/taco.cjs` in repo-source
/// (debug) mode.
///
/// `taco.cjs` is CJS, so plain Node is enough — do not go through the
/// `node_modules/.bin/tsx` shim. On Windows that shim is `tsx.cmd`, and
/// Node 22+ rejects `.cmd`/`.bat` with `spawn EINVAL` (CVE-2024-27980).
/// macOS/Linux hide this because their shim is a real executable with a
/// shebang. `Command::new("node.exe")` searches PATH for the `.exe`; a
/// bare `node` on Windows does not consult PATHEXT.
pub(crate) fn resolve_repo_source_program() -> String {
    NODE_PROGRAM_FILENAME.to_string()
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
