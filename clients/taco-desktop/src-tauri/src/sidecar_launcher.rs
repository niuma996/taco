//! Sidecar launcher resolution — what to spawn, how to connect to it.
//!
//! Two related-but-distinct concerns live here:
//!   * `resolve_sidecar` decides the program / args / env to spawn the daemon
//!     with, based on debug-vs-release and a few override env vars.
//!   * `resolve_install_launcher` and `resolve_install_launcher_via_handle`
//!     decide which CLI binary the desktop uses to run `taco install` /
//!     `taco upgrade --apply` — i.e. the first-run service registration and
//!     the apply step on a pending upgrade marker.
//!
//! Both depend on `paths.rs` for socket-path computation and TACO_HOME
//! resolution, but otherwise don't share state with the workspace_* Tauri
//! commands in `lib.rs`.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::paths::{
    control_socket_path, find_repo_root, ndjson_socket_path, resolve_repo_source_program,
    resolve_taco_home, strip_win_verbatim,
};

/// Env vars forwarded from the desktop process into the sidecar subprocess
/// after `env_clear()`. Whitelist-only so parent-process credentials never
/// leak. PATH / HOME / locale are needed to spawn user commands; the Windows
/// entries let PowerShell (`~` expansion) and Node's `os.homedir()` resolve
/// correctly. A `#[cfg(test)]` assertion at the bottom guards against anyone
/// adding a credential-bearing var (KEY / SECRET / PASSWORD / TOKEN).
pub(crate) const PASSTHROUGH_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TZ",
    "NODE_ENV",
    "TACO_HOME",
    "TACO_SESSIONS_ROOT",
    "TACO_EXTENSIONS_DIR",
    "TACO_EXTENSION_ROOT",
    "TACO_LOG_LEVEL",
    "TACO_DEBUG_LLM_PAYLOAD",
    // Windows: the PowerShell shell tool and Node path/skill resolution
    // (os.homedir, `~` expansion) depend on these. Forwarded explicitly —
    // none of them carry credentials or platform secrets.
    "USERPROFILE",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
];

/// externalBin 的 basename — Tauri 把 `externalBin` 放在 main binary 同目录,
/// 用 `current_exe()` 的父目录定位(`BaseDirectory::Executable` 在 Windows/macOS
/// 不受支持,不可用)。Windows 上文件名带 `.exe`,其余平台不带。
/// (resources 根不走这里,由 `resource_dir()` 直接取。)
pub(crate) const SIDECAR_NODE_RESOURCE: &str = "taco-sidecar-node";

/// 决定 release 与 debug 的 sidecar 程序+参数+运行时资源根。
///
/// 优先级:
///   1. 显式覆盖 `TACO_SIDECAR_CMD` / `TACO_SIDECAR_ARGS` — e2e / 集成测试 / 调试
///   2. debug 构建 (cfg!(debug_assertions)):仓库根 + tsx + 源码
///   3. release:调用 `app.path().resolve_resource()` 定位 bundled node + JS bundle,
///      注入 `TACO_SIDECAR_RESOURCES` 让 sidecar 内 runtimeResources 找 agents/skills。
///   4. release 但 runtime 缺失:报错 — 禁止偷回退到系统 tsx,避免 release 在用户机器
///      静默失败。
/// How to spawn + connect to the sidecar / daemon.
///
/// PR2 reverses the spawn model: instead of forking a tokio subprocess
/// that inherits stdio, the desktop asks the @taco-ai/cli launcher (dev)
/// or the bundled `taco-sidecar-node` (prod) to bring the daemon up,
/// then connects to the NDJSON socket it exposes. The two processes
/// share the same socket paths under `$TACO_HOME/run/` so the
/// launcher's "ready" signal is the same path Rust connects to.
///
/// `extra_env` carries variables PR2 needs in addition to PASSTHROUGH_ENV:
/// `TACO_DAEMON_MODE=1` flips the bundle into socket-listening mode;
/// `TACO_SOCKET` / `TACO_CONTROL_SOCKET` name the two IPC channels. The
/// launcher writes them itself when it acts as an intermediate; the prod
/// path needs them because the desktop sets the paths before spawning.
#[allow(clippy::doc_lazy_continuation)]
pub(crate) struct SidecarResolution {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    /// 注入到 child 的 `TACO_SIDECAR_RESOURCES` env,None 表示不覆盖(由 sidecar
    /// 当前进程的 import.meta.dirname 兜底)。
    pub(crate) resources_root: Option<PathBuf>,
    /// 是否运行仓库源码形态(tsx + repo_root cwd)。区别于 `workspace_ensure`
    /// 入参 `debug_mode`(那是"是否打印 LLM 报文"的客户端开关,两者含义不同)。
    pub(crate) use_repo_source: bool,
    /// NDJSON socket path the bundle should bind. `workspace_ensure`
    /// forwards this to the child as `TACO_SOCKET` and uses it as the
    /// connection target once the daemon is ready.
    pub(crate) socket_path: PathBuf,
    /// Variables to add on top of PASSTHROUGH_ENV when spawning. Includes
    /// `TACO_DAEMON_MODE`, `TACO_SOCKET`, `TACO_CONTROL_SOCKET`, and any
    /// test-time overrides (TACO_SIDECAR_CMD/TACO_SIDECAR_ARGS override the
    /// entire resolution above).
    pub(crate) extra_env: Vec<(String, String)>,
}

pub(crate) fn resolve_sidecar(app: &AppHandle) -> Result<SidecarResolution, String> {
    // PR2: socket paths under `$TACO_HOME/run/` (or Windows named pipes).
    // Both the @taco-ai/cli launcher and the desktop must agree on these
    // paths, so we resolve them once here and pass them to whichever
    // process we spawn.
    let resolved_home = resolve_taco_home(app)?;
    let socket_path = ndjson_socket_path(&resolved_home);
    let control_socket_path = control_socket_path(&resolved_home);
    // Daemon-mode env every spawned child needs. The launcher's
    // TACO_DAEMON_MODE / TACO_SOCKET / TACO_CONTROL_SOCKET come from this
    // vector so the bundle (or CLI) flips into socket-listening mode.
    let daemon_env: Vec<(String, String)> = vec![
        ("TACO_DAEMON_MODE".to_string(), "1".to_string()),
        (
            "TACO_SOCKET".to_string(),
            socket_path.to_string_lossy().into_owned(),
        ),
        (
            "TACO_CONTROL_SOCKET".to_string(),
            control_socket_path.to_string_lossy().into_owned(),
        ),
    ];

    // ① 显式覆盖 —— 测试 / e2e 可以直接指定 launcher 程序
    if let (Ok(program), Ok(args_str)) = (
        std::env::var("TACO_SIDECAR_CMD"),
        std::env::var("TACO_SIDECAR_ARGS"),
    ) {
        return Ok(SidecarResolution {
            program,
            args: args_str.split_whitespace().map(String::from).collect(),
            resources_root: None,
            // 显式覆盖多用于本地/e2e 指向 tsx 源码,按源码形态给 cwd。
            use_repo_source: true,
            socket_path,
            extra_env: daemon_env,
        });
    }

    if cfg!(debug_assertions) {
        // ② debug 走 @taco-ai/cli 的 `start` 子命令 —— 它会 spawn tsx +
        //    sidecar/src/index.ts 并设置好 TACO_DAEMON_MODE / socket 路径。
        //    launch_sidecar() 会等 socket ready 后退出,stdin/stdout 上
        //    透传 socket path。
        let repo_root = find_repo_root();
        let tsx = resolve_repo_source_program(&repo_root);
        let cli_bin = repo_root
            .join("packages")
            .join("cli")
            .join("bin")
            .join("taco.cjs");
        return Ok(SidecarResolution {
            program: tsx,
            args: vec![cli_bin.to_string_lossy().into_owned(), "start".to_string()],
            // CLI 自己计算 socket 路径并 spawn sidecar,不需要 desktop 再注入。
            resources_root: Some(repo_root.join("packages").join("sidecar").join("src")),
            use_repo_source: true,
            socket_path,
            extra_env: daemon_env,
        });
    }

    // ③ release —— 直连 bundled node binary + ESM bundle,跳过 CLI 这一层。
    //    externalBin 不再需要一个独立的 launcher 二进制,因为 bundle 自己
    //    在 TACO_DAEMON_MODE=1 下已经会 listen NDJSON + control sockets。
    //    剥掉 `\\?` verbatim 前缀 —— 这条链上的路径都会作为 argv 传给
    //    Node,带前缀会崩(见 strip_win_verbatim)。
    let resources_root = strip_win_verbatim(
        &app.path()
            .resource_dir()
            .map_err(|e| format!("resource_dir unavailable: {e}"))?,
    );

    let lib_path = resources_root.join("sidecar").join("lib").join("index.mjs");
    if !lib_path.exists() {
        return Err(format!(
            "sidecar bundle missing at {}; \
             run scripts/stageSidecar.mjs (and re-run `pnpm tauri build`)",
            lib_path.display(),
        ));
    }

    let exe_dir = strip_win_verbatim(
        std::env::current_exe()
            .map_err(|e| format!("current_exe unavailable: {e}"))?
            .parent()
            .ok_or_else(|| "current exe has no parent directory".to_string())?,
    );
    let node_bin_name = if cfg!(windows) {
        format!("{SIDECAR_NODE_RESOURCE}.exe")
    } else {
        SIDECAR_NODE_RESOURCE.to_string()
    };
    let node_path = exe_dir.join(&node_bin_name);

    if !node_path.exists() {
        return Err(format!(
            "sidecar node binary not present at {}",
            node_path.display()
        ));
    }

    Ok(SidecarResolution {
        program: node_path.to_string_lossy().into_owned(),
        args: vec![lib_path.to_string_lossy().into_owned()],
        resources_root: Some(resources_root.join("sidecar")),
        use_repo_source: false,
        socket_path,
        extra_env: daemon_env,
    })
}

#[derive(Clone)]
pub(crate) struct InstallLauncherSpec {
    pub(crate) program: String,
    pub(crate) prefix_args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
}

/// Resolve the bundled launcher. Development executes the TypeScript CLI via
/// tsx; release executes the bundled `cli/taco.mjs` with the same sidecar Node
/// binary shipped as Tauri externalBin, so first-run registration never relies
/// on a global `taco` command.
pub(crate) fn resolve_install_launcher(app: &tauri::App) -> Option<InstallLauncherSpec> {
    if cfg!(debug_assertions) {
        let repo_root = find_repo_root();
        let tsx = resolve_repo_source_program(&repo_root);
        let cli_bin = repo_root
            .join("packages")
            .join("cli")
            .join("bin")
            .join("taco.cjs");
        if cli_bin.exists() {
            return Some(InstallLauncherSpec {
                program: tsx,
                prefix_args: vec![cli_bin.to_string_lossy().into_owned()],
                env: Vec::new(),
            });
        }
        return None;
    }
    let resources = app
        .path()
        .resource_dir()
        .ok()?
        .join("cli")
        .join("taco.mjs");
    let sidecar_root = app.path().resource_dir().ok()?.join("sidecar");
    let bundle = sidecar_root.join("lib").join("index.mjs");
    let node = std::env::current_exe().ok()?.parent()?.join(if cfg!(windows) {
        "taco-sidecar-node.exe"
    } else {
        "taco-sidecar-node"
    });
    if !resources.exists() || !node.exists() || !bundle.exists() {
        return None;
    }
    Some(InstallLauncherSpec {
        program: node.to_string_lossy().into_owned(),
        prefix_args: vec![resources.to_string_lossy().into_owned()],
        env: vec![
            ("TACO_SIDECAR_NODE".into(), node.to_string_lossy().into_owned()),
            ("TACO_SIDECAR_BUNDLE".into(), bundle.to_string_lossy().into_owned()),
            ("TACO_SIDECAR_RESOURCES".into(), sidecar_root.to_string_lossy().into_owned()),
        ],
    })
}

/// Mirror of `resolve_install_launcher` that takes an `AppHandle`
/// instead of `&tauri::App`. The two share a body, but the upgrade
/// command is a Tauri command (so it gets `AppHandle`) while the
/// install path runs inside the `.setup` closure (so it gets
/// `&tauri::App`). Splitting them keeps each call site obvious about
/// which API surface it's plugging into without paying for a generic
/// wrapper that would erase the lifetime constraints Tauri imposes.
pub(crate) fn resolve_install_launcher_via_handle(app: &AppHandle) -> Option<InstallLauncherSpec> {
    if cfg!(debug_assertions) {
        let repo_root = find_repo_root();
        let tsx = resolve_repo_source_program(&repo_root);
        let cli_bin = repo_root
            .join("packages")
            .join("cli")
            .join("bin")
            .join("taco.cjs");
        if cli_bin.exists() {
            return Some(InstallLauncherSpec {
                program: tsx,
                prefix_args: vec![cli_bin.to_string_lossy().into_owned()],
                env: Vec::new(),
            });
        }
        return None;
    }
    let resources = app.path().resource_dir().ok()?.join("cli").join("taco.mjs");
    let sidecar_root = app.path().resource_dir().ok()?.join("sidecar");
    let bundle = sidecar_root.join("lib").join("index.mjs");
    let node = std::env::current_exe().ok()?.parent()?.join(if cfg!(windows) {
        "taco-sidecar-node.exe"
    } else {
        "taco-sidecar-node"
    });
    if !resources.exists() || !node.exists() || !bundle.exists() {
        return None;
    }
    Some(InstallLauncherSpec {
        program: node.to_string_lossy().into_owned(),
        prefix_args: vec![resources.to_string_lossy().into_owned()],
        env: vec![
            ("TACO_SIDECAR_NODE".into(), node.to_string_lossy().into_owned()),
            ("TACO_SIDECAR_BUNDLE".into(), bundle.to_string_lossy().into_owned()),
            ("TACO_SIDECAR_RESOURCES".into(), sidecar_root.to_string_lossy().into_owned()),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::PASSTHROUGH_ENV;

    /// Guard against anyone adding a credential-bearing var to
    /// PASSTHROUGH_ENV. `env_clear()` runs in the spawn path; the only
    /// thing between the desktop's environment and the spawned child is
    /// this list. Matches case-insensitively because Windows env vars
    /// are case-insensitive.
    #[test]
    fn passthrough_env_contains_no_credentials() {
        for key in PASSTHROUGH_ENV {
            let upper = key.to_ascii_uppercase();
            assert!(!upper.contains("KEY"), "{key} looks like a credential var");
            assert!(!upper.contains("SECRET"), "{key} looks like a credential var");
            assert!(!upper.contains("PASSWORD"), "{key} looks like a credential var");
            assert!(!upper.contains("TOKEN"), "{key} looks like a credential var");
        }
    }
}