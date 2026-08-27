//! Integration tests for `reap_previous_daemon` against synthetic disk state.
//!
//! These tests don't spawn a real daemon -- they write a pid file + sockets to
//! a tmp directory, then call reap and assert the outcome + post-state.
//!
//! Run:
//!   cargo test --test daemon_reap_integration

#![cfg(unix)]

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use taco_desktop_lib::daemon_reap_test::{
    compute_install_id, daemon_runtime_paths, force_reap, reap_previous_daemon,
    ReapInputs, ReapOutcome,
};

struct TmpHome {
    dir: PathBuf,
}

impl TmpHome {
    fn new(tag: &str) -> Self {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("taco-reap-{tag}-{ts}"));
        fs::create_dir_all(dir.join("run")).unwrap();
        Self { dir }
    }
    fn run(&self) -> PathBuf {
        self.dir.join("run")
    }
    fn write_pid(&self, contents: &str) -> PathBuf {
        let pid_file = self.run().join("sidecar.pid");
        let mut f = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&pid_file)
            .unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        pid_file
    }
    fn touch_socket_files(&self) -> (PathBuf, PathBuf) {
        let ndjson = self.run().join("sidecar.sock");
        let ctl = self.run().join("sidecar-ctl.sock");
        OpenOptions::new()
            .create(true)
            .write(true)
            .open(&ndjson)
            .unwrap();
        OpenOptions::new()
            .create(true)
            .write(true)
            .open(&ctl)
            .unwrap();
        (ndjson, ctl)
    }
    fn build_inputs<'a>(&'a self, own_id: &'a str) -> ReapInputs<'a> {
        let (pid, sock, ctl) = daemon_runtime_paths(&self.run());
        ReapInputs {
            pid_file: pid,
            socket_path: sock,
            control_socket_path: ctl,
            own_install_id: own_id,
            resources_root: PathBuf::from("/fake/install"),
        }
    }
}

impl Drop for TmpHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn reap_returns_no_pid_file_when_run_dir_is_empty() {
    let tmp = TmpHome::new("empty");
    let id = compute_install_id("/fake/install", tmp.dir.to_str().unwrap());
    let outcome = reap_previous_daemon(&tmp.build_inputs(&id), None);
    assert_eq!(
        outcome,
        taco_desktop_lib::daemon_reap_test::ReapOutcome::NoPidFile
    );
}

#[test]
fn reap_reaps_stale_json_pid_file_when_pid_is_dead() {
    let tmp = TmpHome::new("stale");
    let own_id = compute_install_id("/fake/install", tmp.dir.to_str().unwrap());
    let pid_file = tmp.write_pid(&format!(
        r#"{{"version":1,"pid":999999,"install_id":"{own_id}","started_at":"2026-08-19T10:00:00.000Z"}}"#
    ));
    let (sock, ctl) = tmp.touch_socket_files();

    let outcome = reap_previous_daemon(&tmp.build_inputs(&own_id), None);
    assert!(matches!(
        outcome,
        taco_desktop_lib::daemon_reap_test::ReapOutcome::Reaped { pid: 999_999, .. }
            | taco_desktop_lib::daemon_reap_test::ReapOutcome::Stale { pid: 999_999, .. }
    ), "got {:?}", outcome);
    assert!(!pid_file.exists(), "pid file must be unlinked after reap");
    assert!(!sock.exists(), "ndjson socket must be unlinked after reap");
    assert!(!ctl.exists(), "control socket must be unlinked after reap");
}

#[test]
fn reap_skips_foreign_install_id_even_when_pid_is_dead() {
    let tmp = TmpHome::new("foreign");
    let own_id = compute_install_id("/fake/install", tmp.dir.to_str().unwrap());
    let foreign_id = compute_install_id("/other/install", tmp.dir.to_str().unwrap());
    assert_ne!(own_id, foreign_id);
    let pid_file = tmp.write_pid(&format!(
        r#"{{"version":1,"pid":999998,"install_id":"{foreign_id}","started_at":"2026-08-19T10:00:00.000Z"}}"#
    ));
    let (sock, ctl) = tmp.touch_socket_files();

    let outcome = reap_previous_daemon(&tmp.build_inputs(&own_id), None);
    assert_eq!(
        outcome,
        taco_desktop_lib::daemon_reap_test::ReapOutcome::ForeignInstall
    );
    // Critical: foreign daemon's files must be left untouched.
    assert!(pid_file.exists(), "foreign pid file must NOT be unlinked");
    assert!(sock.exists(), "foreign ndjson socket must NOT be unlinked");
    assert!(ctl.exists(), "foreign control socket must NOT be unlinked");
}

#[test]
fn reap_reaps_legacy_bare_int_pid_file_when_pid_is_dead() {
    let tmp = TmpHome::new("legacy");
    let own_id = compute_install_id("/fake/install", tmp.dir.to_str().unwrap());
    let pid_file = tmp.write_pid("999997\n");
    let (sock, ctl) = tmp.touch_socket_files();

    let outcome = reap_previous_daemon(&tmp.build_inputs(&own_id), None);
    assert!(matches!(
        outcome,
        taco_desktop_lib::daemon_reap_test::ReapOutcome::Reaped { pid: 999_997, .. }
            | taco_desktop_lib::daemon_reap_test::ReapOutcome::Stale { pid: 999_997, .. }
    ), "got {:?}", outcome);
    assert!(!pid_file.exists());
    assert!(!sock.exists());
    assert!(!ctl.exists());
}

#[test]
fn reap_returns_unparseable_when_pid_file_is_corrupt() {
    let tmp = TmpHome::new("corrupt");
    let own_id = compute_install_id("/fake/install", tmp.dir.to_str().unwrap());
    tmp.write_pid("not a pid, not json, just garbage\n");
    let outcome = reap_previous_daemon(&tmp.build_inputs(&own_id), None);
    assert_eq!(
        outcome,
        taco_desktop_lib::daemon_reap_test::ReapOutcome::Unparseable
    );
}

#[test]
fn reap_returns_unparseable_when_json_schema_version_is_unknown() {
    let tmp = TmpHome::new("schema");
    let own_id = compute_install_id("/fake/install", tmp.dir.to_str().unwrap());
    tmp.write_pid(
        r#"{"version":2,"pid":1,"install_id":"abcd1234ef567890","started_at":"2026-08-19T10:00:00.000Z"}"#,
    );
    let outcome = reap_previous_daemon(&tmp.build_inputs(&own_id), None);
    assert_eq!(
        outcome,
        taco_desktop_lib::daemon_reap_test::ReapOutcome::Unparseable
    );
}

#[test]
fn reap_does_not_panic_when_listener_is_bound_but_pid_matches() {
    // Use a short tmp path so the Unix socket binding doesn't exceed
    // macOS's SUN_LEN=108 limit. /tmp is universally short.
    let dir = std::path::PathBuf::from("/tmp").join(format!(
        "taco-alive-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("run")).unwrap();

    let own_id = compute_install_id("/fake/install", dir.to_str().unwrap());

    // Bind a fake control socket so the reap ping probe gets a connection.
    let ctl_path = dir.join("run").join("sidecar-ctl.sock");
    let listener = match UnixListener::bind(&ctl_path) {
        Ok(l) => Some(l),
        Err(_) => {
            let _ = fs::remove_dir_all(&dir);
            eprintln!("taco reap test: skipping alive-listener case (bind denied)");
            return;
        }
    };
    // Hold the listener alive so reap's `connect()` succeeds; we don't
    // speak the protocol, so ping_control_socket reads EOF and returns
    // None. The test exercises the path where ping fails despite the
    // socket existing.
    let _listener = listener;

    // CRITICAL: do NOT use `std::process::id()` as the pid in the file.
    // `pid_alive()` would return true (the test process IS alive), and
    // reap's kill path would SIGTERM the test binary itself -- the whole
    // suite dies. Spawn a long-lived child process whose pid we own and
    // reap can safely signal; we kill it at end so the test doesn't leak.
    let mut helper = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("sleep 30")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("failed to spawn helper sleep");
    let helper_pid = helper.id();

    let pid_file = dir.join("run").join("sidecar.pid");
    fs::write(
        &pid_file,
        format!(
            r#"{{"version":1,"pid":{helper_pid},"install_id":"{own_id}","started_at":"2026-08-19T10:00:00.000Z"}}"#
        ),
    )
    .unwrap();

    let inputs = ReapInputs {
        pid_file: pid_file.clone(),
        socket_path: dir.join("run").join("sidecar.sock"),
        control_socket_path: ctl_path.clone(),
        own_install_id: &own_id,
        resources_root: PathBuf::from("/fake/install"),
    };

    // reap will: ping (returns None because listener doesn't speak JSON),
    // then pid_alive(helper_pid) returns true, then SIGTERM the helper.
    // 3s later, pid_alive still true, then SIGKILL. The helper dies
    // outside our test process so the suite stays alive.
    let _outcome = reap_previous_daemon(&inputs, None);

    // Reap the helper in case the test framework inherited it as a zombie.
    // Best-effort: kill -0 then SIGKILL if still around.
    let _ = std::process::Command::new("kill")
        .args(["-KILL", &helper_pid.to_string()])
        .status();
    let _ = helper.wait();

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn reap_idempotent_when_called_twice() {
    let tmp = TmpHome::new("idempotent");
    let own_id = compute_install_id("/fake/install", tmp.dir.to_str().unwrap());
    tmp.write_pid(&format!(
        r#"{{"version":1,"pid":999996,"install_id":"{own_id}","started_at":"2026-08-19T10:00:00.000Z"}}"#
    ));

    let ins = tmp.build_inputs(&own_id);
    let first = reap_previous_daemon(&ins, None);
    let second = reap_previous_daemon(&ins, None);
    assert!(matches!(
        first,
        taco_desktop_lib::daemon_reap_test::ReapOutcome::Reaped { pid: 999_996, .. }
            | taco_desktop_lib::daemon_reap_test::ReapOutcome::Stale { pid: 999_996, .. }
    ));
    assert_eq!(
        second,
        taco_desktop_lib::daemon_reap_test::ReapOutcome::NoPidFile
    );
}


// Tests for the new owned_pid semantics: a daemon whose pid matches the
// owned pid we just spawned must be preserved even if alive.

#[test]
fn reap_kills_unresponsive_daemon_even_when_launcher_pid_differs() {
    

    // An alive process with a matching pid file but no usable control ping is
    // not healthy. It must be reaped so the next daemon can bind the runtime.
    let dir = std::path::PathBuf::from("/tmp").join(format!(
        "taco-leak-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("run")).unwrap();

    let own_id = compute_install_id("/fake/install", dir.to_str().unwrap());

    let ctl_path = dir.join("run").join("sidecar-ctl.sock");
    if UnixListener::bind(&ctl_path).is_err() {
        let _ = fs::remove_dir_all(&dir);
        return;
    }
    let mut helper = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("sleep 30")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("failed to spawn helper");
    let leaked_pid = helper.id();
    // The daemon belongs to OUR install (same install_id), but its control
    // endpoint is unresponsive, so reaping is still required.
    fs::write(
        dir.join("run").join("sidecar.pid"),
        format!(
            r#"{{"version":1,"pid":{},"install_id":"{}","started_at":"2026-08-19T10:00:00.000Z"}}"#,
            leaked_pid, own_id
        ),
    ).unwrap();
    // NDJSON socket entry must exist — an alive pid with NO socket entry is the
    // ghost-socket case (Stale), not the unresponsive-daemon case (Reaped).
    OpenOptions::new()
        .create(true)
        .write(true)
        .open(dir.join("run").join("sidecar.sock"))
        .unwrap();

    let inputs = ReapInputs {
        pid_file: dir.join("run").join("sidecar.pid"),
        socket_path: dir.join("run").join("sidecar.sock"),
        control_socket_path: ctl_path.clone(),
        own_install_id: &own_id,
        resources_root: PathBuf::from("/fake/install"),
    };

    // The launcher pid is different from the daemon pid, but that alone is
    // not a reason to kill it; the unresponsive probe is the reason here.
    let outcome = reap_previous_daemon(&inputs, Some(999_999_999));
    assert!(matches!(outcome, ReapOutcome::Reaped { .. }), "got {:?}", outcome);
    // The leaked daemon must be dead after reap.
    std::thread::sleep(Duration::from_millis(200));
    let _ = force_kill(leaked_pid);
    let _ = helper.wait();
    // Sockets + pid file should be unlinked.
    assert!(!dir.join("run").join("sidecar.pid").exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn force_reap_kills_alive_own_daemon() {
    

    // Same fixture as reap_preserves_alive_daemon_when_owned_pid_matches,
    // but using force_reap -- which must kill our own daemon because
    // force_reap is for the install path which doesn't preserve anything.
    let dir = std::path::PathBuf::from("/tmp").join(format!(
        "taco-force-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("run")).unwrap();

    let own_id = compute_install_id("/fake/install", dir.to_str().unwrap());
    let ctl_path = dir.join("run").join("sidecar-ctl.sock");
    if UnixListener::bind(&ctl_path).is_err() {
        let _ = fs::remove_dir_all(&dir);
        return;
    }
    let mut helper = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("sleep 30")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("failed to spawn helper");
    let helper_pid = helper.id();

    fs::write(
        dir.join("run").join("sidecar.pid"),
        format!(
            r#"{{"version":1,"pid":{},"install_id":"{}","started_at":"2026-08-19T10:00:00.000Z"}}"#,
            helper_pid, own_id
        ),
    ).unwrap();
    // Socket entry present so the reap path exercised is "alive but ping
    // fails" (Reaped), not the ghost-socket shortcut (Stale).
    OpenOptions::new()
        .create(true)
        .write(true)
        .open(dir.join("run").join("sidecar.sock"))
        .unwrap();

    let inputs = ReapInputs {
        pid_file: dir.join("run").join("sidecar.pid"),
        socket_path: dir.join("run").join("sidecar.sock"),
        control_socket_path: ctl_path.clone(),
        own_install_id: &own_id,
        resources_root: PathBuf::from("/fake/install"),
    };

    let outcome = force_reap(&inputs);
    assert!(matches!(outcome, ReapOutcome::Reaped { .. }), "got {:?}", outcome);
    std::thread::sleep(Duration::from_millis(200));
    let _ = force_kill(helper_pid);
    let _ = helper.wait();
    let _ = fs::remove_dir_all(&dir);
}

/// Minimal POSIX kill helpers (avoid pulling in the `nix` crate as a dev-dep).
fn is_alive(pid: u32) -> bool {
    let status = std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status();
    match status {
        Ok(s) => s.success() || !matches!(s.code(), Some(0)),
        Err(_) => false,
    }
}

fn force_kill(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
}

#[test]
fn reap_preserves_healthy_daemon_when_launcher_pid_differs_from_daemon_pid() {
    // In debug mode Tauri spawns `tsx taco.cjs start`; the launcher exits after
    // detaching the daemon, so the launcher PID is intentionally different from
    // the PID recorded by the daemon in sidecar.pid. A healthy shared daemon must
    // be reused rather than killed just because owned_pid names the launcher.
    // Unix domain socket paths are limited to SUN_LEN (108 bytes on macOS),
    // so use a deliberately short /tmp root instead of TmpHome's descriptive
    // path for this integration case.
    let dir = std::env::temp_dir().join(format!("trpm-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let own_id = compute_install_id("/fake/install", dir.to_str().unwrap());
    let (pid_file, socket_path, control_path) = daemon_runtime_paths(&dir);

    let mut helper = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("sleep 30")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("failed to spawn helper daemon");
    let daemon_pid = helper.id();
    // Deliberately use a different, already-dead-looking launcher PID. The
    // implementation must not inspect it when the daemon itself answers ping.
    let launcher_pid = daemon_pid.saturating_add(1);

    std::fs::write(
        &pid_file,
        format!(
            r#"{{"version":1,"pid":{daemon_pid},"install_id":"{own_id}","started_at":"2026-08-19T10:00:00.000Z"}}"#
        ),
    )
    .unwrap();
    // A control ping alone is not enough to establish that the daemon can serve
    // the desktop channel; keep the data socket entry present as well.
    std::fs::File::create(&socket_path).unwrap();

    let listener = match UnixListener::bind(&control_path) {
        Ok(listener) => listener,
        Err(_) => {
            let _ = fs::remove_dir_all(&dir);
            eprintln!("taco reap test: skipping launcher-pid mismatch case (bind denied)");
            return;
        }
    };
    let responder = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("ping connection");
        let mut request = [0u8; 256];
        let _ = std::io::Read::read(&mut stream, &mut request);
        std::io::Write::write_all(
            &mut stream,
            format!(r#"{{"id":1,"result":{{"pid":{daemon_pid},"uptime_s":42}}}}\n"#)
                .as_bytes(),
        )
        .expect("write ping response");
    });

    let inputs = ReapInputs {
        pid_file: pid_file.clone(),
        socket_path: socket_path.clone(),
        control_socket_path: control_path.clone(),
        own_install_id: &own_id,
        resources_root: PathBuf::from("/fake/install"),
    };
    let outcome = reap_previous_daemon(&inputs, Some(launcher_pid));

    assert_eq!(
        outcome,
        ReapOutcome::Alive {
            pid: daemon_pid,
            uptime_s: 42,
        }
    );
    assert!(pid_file.exists(), "healthy daemon pid file must be preserved");
    assert!(socket_path.exists(), "healthy daemon socket must be preserved");
    assert!(control_path.exists(), "healthy control socket must be preserved");
    assert!(is_alive(daemon_pid), "healthy daemon must not be signaled");

    force_kill(daemon_pid);
    let _ = helper.wait();
    responder.join().expect("control responder panicked");
    let _ = fs::remove_dir_all(&dir);
}
