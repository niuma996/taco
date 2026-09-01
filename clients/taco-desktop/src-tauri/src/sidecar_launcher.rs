//! Sidecar launcher resolution — what to spawn, how to connect to it.
//!
//! Two related-but-distinct concerns live here:
//!   * `resolve_sidecar` decides the program / args / env to spawn the
//!     daemon with, based on debug-vs-release and a few override env vars.
//!   * `resolve_install_launcher` (+ `_via_handle`) decide which CLI binary
//!     the desktop uses for `taco install` / `taco upgrade --apply` — i.e.
//!     the first-run service registration and the apply step on a pending
//!     upgrade marker.
//!
//! Both depend on `paths.rs` for socket-path computation and TACO_HOME
//! resolution, but otherwise don't share state with the workspace_*
//! Tauri commands in `lib.rs`.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::paths::{
    control_socket_path, find_repo_root, ndjson_socket_path, resolve_repo_source_program,
    resolve_taco_home, resolve_taco_runtime_dir, strip_win_verbatim,
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
    "TACO_RUNTIME_DIR",
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

/// Env vars forwarded ONLY from debug builds, on top of `PASSTHROUGH_ENV`.
///
/// `NODE_OPTIONS` is deliberately not in the unconditional list. It accepts
/// `--require`, so forwarding it hands whoever controls the desktop's
/// environment a way to load arbitrary code into the sidecar — a
/// categorically different exposure from the path/locale vars above, whose
/// comment promises they carry no secrets. A release build must not
/// widen that surface just so a developer can pass a diagnostic flag.
///
/// In debug builds it is what makes V8 flags reachable: the desktop is
/// the only thing that spawns the daemon (a pre-started one is killed and
/// replaced the moment reap judges it unhealthy, and the replacement comes
/// from this spawn path), so without this there is no way to get
/// `--heapsnapshot-near-heap-limit=1` onto the process that actually crashes.
#[cfg(debug_assertions)]
pub(crate) const DEBUG_ONLY_PASSTHROUGH_ENV: &[&str] = &["NODE_OPTIONS", "TACO_DISABLE_MCP"];

/// externalBin basename — Tauri places `externalBin` next to the main binary; locate it via
/// `current_exe()`'s parent dir (`BaseDirectory::Executable` is unsupported on Windows/macOS,
/// so it can't be used here). Filename has `.exe` on Windows, none elsewhere. The resources
/// root does not go through here; it is taken directly from `resource_dir()`.
pub(crate) const SIDECAR_NODE_RESOURCE: &str = "taco-sidecar-node";

/// Resolve the sidecar program + args + runtime resources root for the current build mode.
///
/// Priority: (1) `TACO_SIDECAR_CMD` / `TACO_SIDECAR_ARGS` overrides for e2e / integration
/// tests; (2) debug build → repo root + tsx + source tree; (3) release → bundle via
/// `app.path().resolve_resource()` for bundled node + bundle, with `TACO_SIDECAR_RESOURCES`
/// injected so the sidecar finds agents/skills; (4) release but runtime missing → ERROR
/// (never fall back to system tsx; silent failure on a release install is worse than loud).
///
/// `extra_env` carries variables PR2 needs beyond PASSTHROUGH_ENV: `TACO_DAEMON_MODE=1`
/// triggers socket-listening mode; `TACO_SOCKET` / `TACO_CONTROL_SOCKET` name the two IPC
/// channels. The launcher writes those itself when it acts as an intermediate; the prod
/// path needs them because the desktop sets the paths before spawning.
#[allow(clippy::doc_lazy_continuation)]
pub(crate) struct SidecarResolution {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    /// `TACO_SIDECAR_RESOURCES` env injected into the child. None means "do not override"
    /// (the sidecar's own process falls back to import.meta.dirname).
    pub(crate) resources_root: Option<PathBuf>,
    /// Whether to run from repo source (tsx + repo_root cwd). Distinct from the
    /// `workspace_ensure` `debug_mode` arg (the client toggle for "print LLM payloads");
    /// the two are unrelated.
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

fn daemon_environment(
    taco_home: &std::path::Path,
    runtime_dir: &std::path::Path,
    socket_path: &std::path::Path,
    control_socket_path: &std::path::Path,
) -> Vec<(String, String)> {
    vec![
        (
            "TACO_HOME".to_string(),
            taco_home.to_string_lossy().into_owned(),
        ),
        (
            "TACO_RUNTIME_DIR".to_string(),
            runtime_dir.to_string_lossy().into_owned(),
        ),
        ("TACO_DAEMON_MODE".to_string(), "1".to_string()),
        (
            "TACO_SOCKET".to_string(),
            socket_path.to_string_lossy().into_owned(),
        ),
        (
            "TACO_CONTROL_SOCKET".to_string(),
            control_socket_path.to_string_lossy().into_owned(),
        ),
    ]
}

pub(crate) fn resolve_sidecar(app: &AppHandle) -> Result<SidecarResolution, String> {
    // Socket paths live in the resolved daemon runtime directory (or Windows
    // named pipes). Both the @taco-ai/cli launcher and the desktop must agree on these
    // paths, so we resolve them once here and pass them to whichever
    // process we spawn.
    let resolved_home = resolve_taco_home(app)?;
    let runtime_dir = resolve_taco_runtime_dir(app)?;
    let socket_path = ndjson_socket_path(&runtime_dir);
    let control_socket_path = control_socket_path(&runtime_dir);
    // Daemon-mode env every spawned child needs. The launcher's
    // TACO_DAEMON_MODE / TACO_SOCKET / TACO_CONTROL_SOCKET come from this
    // vector so the bundle (or CLI) flips into socket-listening mode.
    let daemon_env = daemon_environment(
        &resolved_home,
        &runtime_dir,
        &socket_path,
        &control_socket_path,
    );

    // (1) Explicit override — tests / e2e can specify the launcher program directly.
    if let (Ok(program), Ok(args_str)) = (
        std::env::var("TACO_SIDECAR_CMD"),
        std::env::var("TACO_SIDECAR_ARGS"),
    ) {
        return Ok(SidecarResolution {
            program,
            args: args_str.split_whitespace().map(String::from).collect(),
            resources_root: None,
            // Explicit overrides typically point at tsx source for local / e2e, so give
            // it the repo-source cwd.
            use_repo_source: true,
            socket_path,
            extra_env: daemon_env,
        });
    }

    if cfg!(debug_assertions) {
        // (2) Debug goes through the @taco-ai/cli `start` subcommand. That command spawns
        //     tsx + sidecar/src/index.ts and sets TACO_DAEMON_MODE / socket paths itself.
        //     `launch_sidecar()` waits for the socket to be ready then exits, forwarding
        //     socket paths over stdin/stdout.
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
            // The CLI resolves the runtime paths and spawns the sidecar; desktop
            // forwards the shared home plus isolated runtime through extra_env.
            resources_root: Some(repo_root.join("packages").join("sidecar").join("src")),
            use_repo_source: true,
            socket_path,
            extra_env: daemon_env,
        });
    }

    // (3) Release — connect directly to the bundled node binary + ESM bundle, skipping
    //     the CLI layer. externalBin no longer needs a separate launcher binary because
    //     the bundle itself, under TACO_DAEMON_MODE=1, already listens on NDJSON + control
    //     sockets. Strip the `\\?` verbatim prefix — paths on this chain are passed as argv
    //     to Node, and the prefix would crash it (see strip_win_verbatim).
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
    let resources = app.path().resource_dir().ok()?.join("cli").join("taco.mjs");
    let sidecar_root = app.path().resource_dir().ok()?.join("sidecar");
    let bundle = sidecar_root.join("lib").join("index.mjs");
    let node = std::env::current_exe()
        .ok()?
        .parent()?
        .join(if cfg!(windows) {
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
            (
                "TACO_SIDECAR_NODE".into(),
                node.to_string_lossy().into_owned(),
            ),
            (
                "TACO_SIDECAR_BUNDLE".into(),
                bundle.to_string_lossy().into_owned(),
            ),
            (
                "TACO_SIDECAR_RESOURCES".into(),
                sidecar_root.to_string_lossy().into_owned(),
            ),
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
    let node = std::env::current_exe()
        .ok()?
        .parent()?
        .join(if cfg!(windows) {
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
            (
                "TACO_SIDECAR_NODE".into(),
                node.to_string_lossy().into_owned(),
            ),
            (
                "TACO_SIDECAR_BUNDLE".into(),
                bundle.to_string_lossy().into_owned(),
            ),
            (
                "TACO_SIDECAR_RESOURCES".into(),
                sidecar_root.to_string_lossy().into_owned(),
            ),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::{daemon_environment, PASSTHROUGH_ENV};
    use std::path::Path;

    /// Guard against anyone adding a credential-bearing var to
    /// PASSTHROUGH_ENV. `env_clear()` runs in the spawn path; the only
    /// thing between the desktop's environment and the spawned child is
    /// this list. Matches case-insensitively because Windows env vars
    /// are case-insensitive.
    #[test]
    fn daemon_environment_keeps_shared_home_and_isolated_runtime() {
        let env = daemon_environment(
            Path::new("/Users/test/.taco"),
            Path::new("/Users/test/.taco-dev/run"),
            Path::new("/Users/test/.taco-dev/run/sidecar.sock"),
            Path::new("/Users/test/.taco-dev/run/sidecar-ctl.sock"),
        );
        assert!(env.contains(&(String::from("TACO_HOME"), String::from("/Users/test/.taco"))));
        assert!(env.contains(&(
            String::from("TACO_RUNTIME_DIR"),
            String::from("/Users/test/.taco-dev/run"),
        )));
        assert!(env.contains(&(
            String::from("TACO_SOCKET"),
            String::from("/Users/test/.taco-dev/run/sidecar.sock"),
        )));
        assert!(env.contains(&(
            String::from("TACO_CONTROL_SOCKET"),
            String::from("/Users/test/.taco-dev/run/sidecar-ctl.sock"),
        )));
    }

    #[test]
    fn passthrough_env_contains_no_credentials() {
        for key in PASSTHROUGH_ENV {
            let upper = key.to_ascii_uppercase();
            assert!(!upper.contains("KEY"), "{key} looks like a credential var");
            assert!(
                !upper.contains("SECRET"),
                "{key} looks like a credential var"
            );
            assert!(
                !upper.contains("PASSWORD"),
                "{key} looks like a credential var"
            );
            assert!(
                !upper.contains("TOKEN"),
                "{key} looks like a credential var"
            );
        }
    }
}
