use std::fs;
use std::io::Read;
use std::path::PathBuf;

use taco_desktop_lib::log_file::LogFile;

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "taco-log-{}-{}",
        name,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn appends_and_reads_back() {
    let path = tmp("a").join("log");
    let mut f = LogFile::open(path.clone()).unwrap();
    f.write_line("hello").unwrap();
    f.write_line("world").unwrap();
    f.flush().unwrap();
    let mut s = String::new();
    fs::File::open(&path).unwrap().read_to_string(&mut s).unwrap();
    assert_eq!(s, "hello\nworld\n");
}

#[test]
fn rotates_when_threshold_crossed() {
    // Make a tiny file so even one line triggers rotation on second pass.
    let dir = tmp("rot");
    let path = dir.join("log");
    let mut f = LogFile::open(path.clone()).unwrap();
    let big = "x".repeat(1024);
    // Push the current file past the cap by writing 10 MiB worth.
    for _ in 0..(10 * 1024) {
        f.write_line(&big).unwrap();
    }
    f.flush().unwrap();
    // The rotation threshold is internal; the easiest way to verify it
    // fired is that an older sibling now exists.
    let rotated = path.with_extension("log.1");
    assert!(rotated.exists(), "rotation never produced log.1");
}

#[test]
fn does_not_rotate_empty_file() {
    // If a file is opened and never written to, then a single line arrives
    // that alone exceeds MAX_BYTES, we must not try to rotate the empty
    // file (rename empty → log.1 would still work, but skipping the rename
    // path is simpler and avoids an unnecessary syscall).
    let dir = tmp("empty");
    let path = dir.join("log");
    let mut f = LogFile::open(path.clone()).unwrap();
    // The line exceeds the cap but the file is empty — no rotation.
    f.write_line(&"y".repeat(11 * 1024 * 1024)).unwrap();
    f.flush().unwrap();
    assert!(path.exists());
    assert!(!path.with_extension("log.1").exists());
}

#[test]
fn drops_oldest_past_retained() {
    let dir = tmp("drop");
    let path = dir.join("log");
    // Four rotations worth of content.
    let mut f = LogFile::open(path.clone()).unwrap();
    let big = "z".repeat(1024);
    for _ in 0..(40 * 1024) {
        f.write_line(&big).unwrap();
    }
    f.flush().unwrap();
    // We keep log.1, log.2, log.3 — log.4 is dropped on the next rotation.
    for i in 1..=3 {
        assert!(
            path.with_extension(format!("log.{}", i)).exists(),
            "log.{} should exist",
            i
        );
    }
    assert!(
        !path.with_extension("log.4").exists(),
        "log.4 should have been dropped"
    );
}

#[cfg(unix)]
#[test]
fn files_and_dir_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tmp("perm");
    let files = taco_desktop_lib::log_file::LogFiles::open(&dir).unwrap();
    let mode = |p: &PathBuf| fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&files.dir), 0o700, "logs dir must be 0700");
    assert_eq!(mode(&files.dir.join("taco-desktop.log")), 0o600);
    assert_eq!(mode(&files.dir.join("llm-dump.log")), 0o600);
}

#[cfg(unix)]
#[test]
fn open_tightens_a_preexisting_permissive_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tmp("perm2");
    let logs = dir.join("logs");
    fs::create_dir_all(&logs).unwrap();
    let log = logs.join("taco-desktop.log");
    // Simulate a file left world-readable by an earlier unmasked run.
    fs::write(&log, b"old\n").unwrap();
    fs::set_permissions(&log, fs::Permissions::from_mode(0o644)).unwrap();
    let _files = taco_desktop_lib::log_file::LogFiles::open(&dir).unwrap();
    assert_eq!(fs::metadata(&log).unwrap().permissions().mode() & 0o777, 0o600);
}
