//! Append-mode log file with size-based rotation. No external deps: a
//! `BufWriter` and a `u64` byte counter are all we need.
//!
//! Pinned size cap: 10 MiB per file, 3 retained. Rotation is in-process and
//! synchronous — the caller holds the mutex, so writes from the two stderr
//! readers (main + LLM dump) are already serialized. Keeping rotation under
//! that lock is the simplest way to avoid a torn write during the rename.
//!
//! Permissions: `llm-dump.log` can hold complete LLM payloads, so the files
//! and their directory must not inherit a permissive umask (a typical `022`
//! yields world-readable `0644` files). On Unix we force `0600`/`0700` and
//! re-apply them to pre-existing files that were created loosely. Windows has
//! no umask; the per-user profile ACL already restricts these paths.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufWriter, Write};
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 10 * 1024 * 1024;
const RETAINED: usize = 3;

/// Open `path` for appending with owner-only permissions on Unix. The `mode`
/// only applies at creation; the follow-up `set_permissions` tightens a file
/// that already existed with a looser mode from an earlier, unmasked run.
fn open_private(path: &Path) -> std::io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

/// One log file. `write` appends a line and rotates the family if the
/// current file would exceed `MAX_BYTES`.
pub struct LogFile {
    path: PathBuf,
    // `None` only mid-rotation, while the old handle is dropped so the rename
    // can proceed (Windows refuses to rename an open file). No placeholder
    // path like `/dev/null` — that doesn't exist on Windows.
    writer: Option<BufWriter<File>>,
    bytes: u64,
}

impl LogFile {
    /// Open `path` in append mode, creating it if needed. The parent
    /// directory must already exist.
    pub fn open(path: PathBuf) -> std::io::Result<Self> {
        let file = open_private(&path)?;
        let bytes = file.metadata()?.len();
        Ok(Self {
            path,
            writer: Some(BufWriter::new(file)),
            bytes,
        })
    }

    /// Append a single line (without trailing newline; this method adds it).
    /// Rotates the file family if appending would push it past `MAX_BYTES`.
    pub fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        let added = line.len() as u64 + 1;
        if self.bytes + added > MAX_BYTES && self.bytes > 0 {
            self.rotate()?;
        }
        let writer = self.writer.as_mut().expect("writer present outside rotation");
        writer.write_all(line.as_bytes())?;
        writer.write_all(b"\n")?;
        self.bytes += added;
        Ok(())
    }

    /// Force buffered bytes to disk. Call before dropping if you need the
    /// tail to survive a process crash; otherwise the OS will flush on close.
    pub fn flush(&mut self) -> std::io::Result<()> {
        if let Some(w) = self.writer.as_mut() {
            w.flush()?;
        }
        Ok(())
    }

    /// Shift `path` → `path.1` → … → `path.RETAINED`, dropping the oldest.
    fn rotate(&mut self) -> std::io::Result<()> {
        self.flush()?;
        // Drop the old handle before renaming (Windows locks open files).
        drop(self.writer.take());
        // Drop the tail first so rename-to-self can't happen.
        let oldest = self.path.with_extension(format!("log.{}", RETAINED));
        let _ = fs::remove_file(&oldest);
        for i in (1..RETAINED).rev() {
            let from = self.path.with_extension(format!("log.{}", i));
            let to = self.path.with_extension(format!("log.{}", i + 1));
            if from.exists() {
                fs::rename(&from, &to)?;
            }
        }
        if self.path.exists() {
            fs::rename(&self.path, self.path.with_extension("log.1"))?;
        }
        self.writer = Some(BufWriter::new(open_private(&self.path)?));
        self.bytes = 0;
        Ok(())
    }
}

/// The two files we keep under `$TACO_HOME/logs/`.
pub struct LogFiles {
    pub dir: PathBuf,
    pub main: LogFile,
    pub llm: LogFile,
}

impl LogFiles {
    /// `taco_home` is the absolute path already resolved by
    /// `resolve_taco_home`; this function only creates the `logs/` subdir.
    pub fn open(taco_home: &Path) -> std::io::Result<Self> {
        let dir = ensure_logs_dir(taco_home)?;
        Ok(Self {
            main: LogFile::open(dir.join("taco-desktop.log"))?,
            llm: LogFile::open(dir.join("llm-dump.log"))?,
            dir,
        })
    }
}

/// Create `$TACO_HOME/logs/` with owner-only permissions and return it.
/// Standalone from `LogFiles::open` because the daemon's own stderr tee
/// (`TACO_STDERR_LOG` → `daemon.err.log`) needs the directory even when the
/// llmDumpToFile toggle is off, and it does not create its parent itself.
pub fn ensure_logs_dir(taco_home: &Path) -> std::io::Result<PathBuf> {
    let dir = taco_home.join("logs");
    fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// Copy `[taco:llm]`-prefixed lines from `reader` into `llm`. Returns the
/// number of lines written. The sidecar stderr reader uses this to fold the
/// same payloads that feed the in-memory Dump panel into
/// `$TACO_HOME/logs/llm-dump.log`. Lines without the marker are skipped
/// without touching the file; rotation / permissions / capacity are
/// inherited from `LogFile` and covered by the dedicated tests above.
pub fn tee_llm_dump_lines<R: BufRead>(
    reader: R,
    llm: &mut LogFile,
) -> std::io::Result<usize> {
    let mut written = 0usize;
    for line in reader.lines() {
        let line = line?;
        if line.starts_with("[taco:llm]") {
            llm.write_line(&line)?;
            written += 1;
        }
    }
    Ok(written)
}
