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

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_fs::FsExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};

pub mod log_file;
pub use log_file::LogFiles;

const DEFAULT_SIDECAR_ARGS: &str = "packages/sidecar/src/index.ts";

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
fn resolve_repo_source_program(repo_root: &Path) -> String {
    let local = repo_root
 .join("node_modules")
 .join(".bin")
 .join(SIDECAR_PROGRAM_FILENAME);
    if local.exists() {
        return local.to_string_lossy().into_owned();
    }
    SIDECAR_PROGRAM_FILENAME.to_string()
}

/// Env vars forwarded from the desktop process into the sidecar subprocess
/// after `env_clear()`. Whitelist-only so parent-process credentials never
/// leak. PATH / HOME / locale are needed to spawn user commands; the Windows
/// entries let PowerShell (`~` expansion) and Node's `os.homedir()` resolve
/// correctly. A `#[cfg(test)]` assertion at the bottom guards against anyone
/// adding a credential-bearing var (KEY / SECRET / PASSWORD / TOKEN).
const PASSTHROUGH_ENV: &[&str] = &[
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

/// Prefix the sidecar stamps on LLM-payload dump lines. Kept in sync with
/// `packages/sidecar/src/runtime/hookWiring.ts` (where lines are written)
/// and `clients/taco-desktop/src/hooks/useSidecarStream.ts` (where the
/// frontend matches them for the in-memory LLM Dump panel).
const LLM_DUMP_PREFIX: &str = "[taco:llm]";

/// externalBin 的 basename — Tauri 把 `externalBin` 放在 main binary 同目录,
/// 用 `current_exe()` 的父目录定位(`BaseDirectory::Executable` 在 Windows/macOS
/// 不受支持,不可用)。Windows 上文件名带 `.exe`,其余平台不带。
/// (resources 根不走这里,由 `resource_dir()` 直接取。)
const SIDECAR_NODE_RESOURCE: &str = "taco-sidecar-node";

/// 决定 release 与 debug 的 sidecar 程序+参数+运行时资源根。
///
/// 优先级:
///   1. 显式覆盖 `TACO_SIDECAR_CMD` / `TACO_SIDECAR_ARGS` — e2e / 集成测试 / 调试
///   2. debug 构建 (cfg!(debug_assertions)):仓库根 + tsx + 源码
///   3. release:调用 `app.path().resolve_resource()` 定位 bundled node + JS bundle,
///      注入 `TACO_SIDECAR_RESOURCES` 让 sidecar 内 runtimeResources 找 agents/skills。
///   4. release 但 runtime 缺失:报错 — 禁止偷回退到系统 tsx,避免 release 在用户机器
///      静默失败。
struct SidecarResolution {
    program: String,
    args: Vec<String>,
    /// 注入到 child 的 `TACO_SIDECAR_RESOURCES` env,None 表示不覆盖(由 sidecar
    /// 当前进程的 import.meta.dirname 兜底)。
    resources_root: Option<PathBuf>,
    /// 是否运行仓库源码形态(tsx + repo_root cwd)。区别于 `workspace_ensure`
    /// 入参 `debug_mode`(那是"是否打印 LLM 报文"的客户端开关,两者含义不同)。
    use_repo_source: bool,
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
fn resolve_taco_home(app: &AppHandle) -> Result<PathBuf, String> {
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

/// 剥掉 Windows verbatim 前缀(`\\?\`)。
///
/// `current_exe()` / `resource_dir()` 在 Windows 上可能返回 `\\?\D:\...` 这种
/// verbatim 路径。Rust 自己的 `std::fs` 能正确处理它,但把它作为 argv 传给
/// 子进程会出问题:Node 的 `realpath` 见到 `\\?\D:` 会把盘符解析成目录,直接
/// 崩 `EISDIR: illegal operation on a directory, lstat 'D:'`(整个 sidecar 因此
/// 起不来)。在传给 `Command` 之前统一剥掉,非 Windows / 无前缀时原样返回。
fn strip_win_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p.to_path_buf(),
    }
}

fn resolve_sidecar(app: &AppHandle) -> Result<SidecarResolution, String> {
    // ① 显式覆盖
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
        });
    }

    if cfg!(debug_assertions) {
        // ② debug 走源码,沿用原本 repo+tsx 形态
        let repo_root = find_repo_root();
        return Ok(SidecarResolution {
            program: resolve_repo_source_program(&repo_root),
            args: DEFAULT_SIDECAR_ARGS
                .split_whitespace()
                .map(String::from)
                .collect(),
            // 也注入,使得 runtimeResources resourceRoot() 走 env 一致;必须指向
            // packages/sidecar/src(agents/、skills/ 的父级),不是 monorepo 根,
            // 否则 resourceRoot() 短路后 builtinDir 会落到不存在的路径。
            resources_root: Some(repo_root.join("packages").join("sidecar").join("src")),
            use_repo_source: true,
        });
    }

    // ③ release
    // 剥掉 `\\?\` verbatim 前缀 —— 这条链(resource_dir → lib_path、current_exe →
    // node_path)上的路径都会作为 argv 传给 Node,带前缀会崩(见 strip_win_verbatim)。
    let resources_root = strip_win_verbatim(
        &app.path()
            .resource_dir()
            .map_err(|e| format!("resource_dir unavailable: {e}"))?,
    );

    // 资源子目录 sidecar/,sidecar/lib/index.mjs 是 staged bundle
    let lib_path = resources_root.join("sidecar").join("lib").join("index.mjs");
    if !lib_path.exists() {
        return Err(format!(
            "sidecar bundle missing at {}; \
             run scripts/stageSidecar.mjs (and re-run `pnpm tauri build`)",
            lib_path.display(),
        ));
    }

    // externalBin 在 release 里被 Tauri 放在主程序同目录(Windows NSIS 安装目录、
    // macOS .app/Contents/MacOS)。定位它**不能**用
    // `path().resolve(.., BaseDirectory::Executable)` —— 该 base 的
    // `executable_dir()` 在 Windows/macOS 上不受支持,直接返回 `Error::UnknownPath`
    // (报 "unknown path"),导致 Windows 安装版永远解析不到侧车。改用
    // `current_exe()` 的父目录,跨平台都指向主程序所在目录。
    let exe_dir = strip_win_verbatim(
        std::env::current_exe()
            .map_err(|e| format!("current_exe unavailable: {e}"))?
            .parent()
            .ok_or_else(|| "current exe has no parent directory".to_string())?,
    );
    // Tauri 打包 externalBin 时,会把 staging 的 `taco-sidecar-node-<triple>[.exe]`
    // 重命名回 basename(Windows 上带 .exe,其余平台不带)。按平台拼同样的名字。
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
    })
}

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
        }
    }
}

pub struct SharedSidecar {
    pub child: Child,
    pub stdin_tx: mpsc::Sender<String>,
    /// 进程代次 — stdout EOF 清理时比对,避免旧进程的 reader 抹掉刚重启的新进程。
    generation: u64,
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
    let _ = cwd; // API 兼容保留;repo-source 模式的工作目录用 find_repo_root(),与此无关。
    // 「首次生效」在此函数体现:任何在 slot 已有值之后的 ensure 调用都早返回,
    // 因此 `cwd` / `debug_mode` / llm_dump_to_file / env_clear() 都不会再跑。
    // 这些开关的切换必须经过 restartSidecar(参见 App.tsx:dispose → 重 start),
    // 否则被静默丢弃。

    // 第一道关:已存在共享进程或 dispose 已发起 → 不 spawn。
    {
        let slot = state.sidecar.lock().await;
        if let Some(existing) = slot.as_ref() {
            // 复用现存进程时把握手行交回调用方。代次比对确保拿到的是**这个**
            // 进程的握手行,而不是上一代残留的。
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

    // 第二段:spawn 在锁外执行 —— 这样 dispose 可以 acquire 锁、设
    // shutdown flag,我们在 install 前看到 flag 时杀掉孤儿进程,避免
    // 「start() 拿到 hello 后又立即收到 sidecar-exited」的 zombie 局面。
    let resolution = resolve_sidecar(&app)?;
    let mut cmd = Command::new(&resolution.program);
    for a in &resolution.args {
        cmd.arg(a);
    }
    if resolution.use_repo_source {
        // 源码形态沿用 repo_root cwd(与原本约定一致)
        let repo_root = find_repo_root();
        cmd.current_dir(&repo_root);
    }
    // release 下不指定 cwd — 让 Node 用其所在父目录即可,资源全部走 TACO_SIDECAR_RESOURCES

    // Windows: 禁止 sidecar Node 进程弹出黑色控制台窗口(原进程 TACO.exe 是
    // GUI subsystem,默认子进程会继承一个 conhost.exe 窗口 —— 显式置
    // CREATE_NO_WINDOW = 0x08000000 才不显示)。DETACHED_PROCESS 会切断 stdio
    // 管道,不能用。
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }

    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    // Clear inherited env so parent-process *_API_KEY (and any other
    // sensitive var the desktop happened to have) does NOT leak into the
    // sidecar subprocess. Sidecar injects its own key material from
    // ~/.taco/taco.json at startup — see packages/sidecar/src/index.ts
    // injectApiKeysToEnv. PATH / HOME / locale are forwarded explicitly
    // because shell tools need them to spawn user commands.
    cmd.env_clear();
    for key in PASSTHROUGH_ENV {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
    // Override the raw TACO_HOME with the value the desktop actually resolved.
    // The same value is also used to open the log files further down; the
    // earlier `if let Ok(...)` from prior revisions is gone — we always need
    // the path for logging, so a silent `if let` would have meant logs landed
    // somewhere unrelated to where desktop.json lives.
    // Forwarding the raw string instead would let a relative or padded value
    // resolve against a different cwd inside the child.
    let resolved_home = resolve_taco_home(&app)?;
    cmd.env("TACO_HOME", &resolved_home);

    // 客户端显式传入 debug_mode(来自 TacoClientSettingsShape,纯客户端字段);
    // 开启则向 sidecar 注入 TACO_DEBUG_LLM_PAYLOAD=1,sidecar 端的
    // before_provider_payload hook 会开始打印完整 LLM 报文到 stderr。
    // 缺省视为关闭(安全默认)。
    // 注意:仅在共享 sidecar 尚未存在时生效(参见函数顶部说明)。
    if debug_mode.unwrap_or(false) {
        cmd.env("TACO_DEBUG_LLM_PAYLOAD", "1");
    }

    if let Some(resources) = &resolution.resources_root {
        cmd.env("TACO_SIDECAR_RESOURCES", resources);
    }

    // Join the previous generation's stderr reader before opening the log
    // files. Its final flush can trip a rotation (the rename chain), and the
    // reader we're about to spawn holds an independent `LogFiles` mutex on the
    // same fixed paths — two live readers would race those renames. The
    // handle is `Some` only while a reader is actually draining, so this is a
    // no-op on first install and cheap on the fast path. Take the handle out
    // before awaiting — a std MutexGuard isn't Send and can't be held across.
    let prior_reader = state.stderr_reader.lock().unwrap().take();
    if let Some(reader) = prior_reader {
        let _ = reader.await;
    }

    // Open log files for this process. We open them here (and not earlier) so
    // the file's lifetime matches the sidecar process's lifetime — a restart
    // produces a fresh file rather than appending to one from a now-dead
    // process. `resolved_home` is the same value we already passed to
    // TACO_HOME above, so desktop.json and the log directory live in the
    // same place.
    // Open log files BEFORE spawn so a setup-time failure (disk full, bad
    // path) doesn't leave a sidecar process running without logs. We hold
    // them in a local Arc and only publish to `state.log_files` inside the
    // install lock below — otherwise a parallel ensure that lost the
    // install race would leak its reader task writing to log files that
    // the new install overwrote.
    let log_files = LogFiles::open(&resolved_home)
        .map_err(|e| format!("failed to open log files under {}: {e}", resolved_home.display()))?;
    let log_files_arc: Arc<StdMutex<LogFiles>> = Arc::new(StdMutex::new(log_files));
    let log_files_for_stderr = log_files_arc.clone();
    let llm_dump_to_file = llm_dump_to_file.unwrap_or(false);
    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn sidecar: {e}"))?;
    let generation = state
        .next_process_generation
        .fetch_add(1, Ordering::Relaxed);

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // 用 channel 把 React invoke 写入 stdin
    let (tx, mut rx) = mpsc::channel::<String>(64);
    tokio::spawn(async move {
        let mut writer = stdin;
        while let Some(line) = rx.recv().await {
            if writer.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if writer.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    // stdout NDJSON 帧原样转发 —— 不解析 JSON。「帧属于哪个 workspace」是应用协议
    // 语义(帧内自带 workspace 字段),由前端 dispatcher 判定;Rust 只做字节管道。
    let app_for_stdout = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut first_line_seen = false;
        while let Ok(Some(line)) = reader.next_line().await {
            if !first_line_seen {
                first_line_seen = true;
                // Retain the first line for ensures that arrive after the
                // handshake was emitted. Tagged with this generation so the
                // reader of a process that lost the install race — or a dead
                // one — can't hand its line to the live process's client.
                *app_for_stdout
                    .state::<AppState>()
                    .handshake_line
                    .lock()
                    .unwrap() = Some((generation, line.clone()));
            }
            let _ = app_for_stdout.emit("sidecar-event", serde_json::json!({ "line": line }));
        }
        // stdout EOF ⇒ 进程结束。代次比对避免抹掉期间已重启的新进程。
        let dead = {
            let state = app_for_stdout.state::<AppState>();
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
        if let Some(mut s) = dead {
            let status = match s.child.try_wait() {
                Ok(Some(status)) => Some(status),
                Ok(None) => {
                    let _ = s.child.kill().await;
                    s.child.wait().await.ok()
                }
                Err(_) => None,
            };
            // 进程级事件 —— 不带 workspace:死的是整个进程,前端据此让所有
            // workspace 的 pending RPC 失败。
            let _ = app_for_stdout.emit("sidecar-exited", serde_json::json!({
                "code": status.and_then(|value| value.code()),
            }));
        }
    });

    // stderr: fan out to the frontend event, the main log file, and (for lines
    // starting with `[taco:llm]` when the user has opted in) the dedicated
    // llm-dump.log. The frontend event is always sent so the in-memory LLM
    // Dump panel works regardless of the disk-write setting.
    let app_for_stderr = app.clone();
    let stderr_reader_handle = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_for_stderr.emit("sidecar-log", serde_json::json!({ "line": line }));

            let mut files = log_files_for_stderr.lock().unwrap();
            if let Err(e) = files.main.write_line(&line) {
                eprintln!("taco-desktop.log write failed: {e}");
            }
            if llm_dump_to_file && line.starts_with(LLM_DUMP_PREFIX) {
                if let Err(e) = files.llm.write_line(&line) {
                    eprintln!("llm-dump.log write failed: {e}");
                }
            }
        }
        // Process is gone — flush whatever's still in the BufWriter so the
        // tail survives a clean exit. (On a hard kill, the OS drops it.)
        let mut files = log_files_for_stderr.lock().unwrap();
        let _ = files.main.flush();
        let _ = files.llm.flush();
    });
    // Register the reader so the next ensure can join it before touching the
    // log files (see the join at the top of this function).
    *app.state::<AppState>().stderr_reader.lock().unwrap() = Some(stderr_reader_handle);

    // 第三道关:install 前再查 shutdown flag 与 slot —— 若 dispose 在 spawn 期间
    // 被触发、或另一个并发 ensure 已经 install,杀掉刚 spawn 的孤儿进程。
    //
    // 这里也是把日志文件句柄正式交给 AppState 的点:之前放在 setup 阶段会
    // 让输掉 install 竞争的 ensure 留下一个孤儿 reader 在写"上一代"日志文件。
    // 现在只有 install 成功时,本地 log_files_arc 才会被发布到 state,
    // 读者在 install 前已经持有自己的 Arc 副本,生命周期与 child 一致。
    let mut slot = state.sidecar.lock().await;
    if state.shutdown_initiated.load(Ordering::Acquire) {
        drop(tx);
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err("sidecar shutting down".into());
    }
    if let Some(existing) = slot.as_ref() {
        // 另一个并发 ensure 已 install —— 我们这个是多余。交回胜出进程的握手行,
        // 与第一道关的早返回同语义。
        drop(tx);
        let _ = child.kill().await;
        let _ = child.wait().await;
        let line = state
            .handshake_line
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(generation, _)| *generation == existing.generation)
            .map(|(_, line)| line.clone());
        return Ok(line);
    }

    // Publish the log files handle atomically with the slot install. The
    // previous install's reader is still holding its own Arc clone, so
    // overwriting state here is safe — it only severs the *state-owned*
    // reference, and state is not the reader's lifetime anchor.
    *state.log_files.lock().unwrap() = Some(log_files_arc);

    *slot = Some(SharedSidecar {
        child,
        stdin_tx: tx,
        generation,
    });

    // We just spawned: the handshake is still in flight and will reach the
    // caller's listener through `sidecar-event`. Nothing to hand back.
    Ok(None)
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
async fn workspace_dispose_all(state: State<'_, AppState>) -> Result<(), String> {
    // 在 acquire 锁之前先 set flag —— 让任何正在进行的 ensure(第一道关内已过、
    // 第二段 spawn 中的)在 install 前能看到 flag,从而杀掉孤儿进程而非被 race-kill
    // 留个 zombie。Reset 在锁外:典型路径是 dispose → 重新 ensure(restartSidecar),
    // reset 后下一次 ensure 能正常 spawn。
    state.shutdown_initiated.store(true, Ordering::Release);
    let dead = {
        let mut slot = state.sidecar.lock().await;
        slot.take()
    };
    if let Some(mut s) = dead {
        // Close stdin so the sidecar receives EOF and can flush sessions /
        // buffers before exiting. Give it a short grace window; force-kill
        // if it doesn't exit in time to avoid leaking the process.
        drop(s.stdin_tx);
        match tokio::time::timeout(Duration::from_secs(3), s.child.wait()).await {
            Ok(_) => {}
            Err(_) => {
                let _ = s.child.kill().await;
                let _ = s.child.wait().await;
            }
        }
    }
    state.shutdown_initiated.store(false, Ordering::Release);
    Ok(())
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

fn normalize_cwd(cwd: &str) -> String {
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

/// Lexically normalize: 解析 `.` / `..` 但不要求路径存在(无 fs 访问)。
/// 与 Node 端 `path.resolve` 行为一致,这是 WorkspaceRuntime 用于 routing key 的语义。
fn cleanpath(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {} // skip .
            Component::ParentDir => {
                // pop only if there's a real prefix / normal component to pop
                if matches!(out.components().next_back(), Some(Component::Normal(_)) | Some(Component::Prefix(_))) {
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

/// 从当前可执行文件向上扫描,找到含 `pnpm-workspace.yaml` 的目录作为 repo root。
/// 跨 `cargo run` / `pnpm tauri:dev` / release `.app` bundle 都稳。
fn find_repo_root() -> PathBuf {
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            workspace_ensure,
            workspace_send,
            workspace_dispose_all,
            set_fs_scope,
            desktop_config_read,
            desktop_config_write,
            default_workspace_dir,
            paths_are_dirs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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

