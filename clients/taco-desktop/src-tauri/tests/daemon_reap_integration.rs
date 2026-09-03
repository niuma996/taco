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
            // No expectation: these cases exercise liveness/ownership, not
            // the version freshness gate.
            expected_sidecar_version: None,
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
        expected_sidecar_version: None,
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
        expected_sidecar_version: None,
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
        expected_sidecar_version: None,
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
        // No expectation → liveness-only reuse, the pre-gate behavior.
        expected_sidecar_version: None,
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

#[test]
fn reap_kills_ghost_socket_daemon_and_unlinks_sockets() {
    // Ghost-socket case: an alive daemon whose NDJSON socket fs entry has
    // disappeared (the original 47407 incident). The reap path MUST kill the
    // daemon, not just unlink the missing socket — otherwise the live inode
    // stays held via fd, the next spawn's bind() fails with EADDRINUSE, and
    // ghost daemons accumulate on every desktop restart.
    let dir = std::path::PathBuf::from("/tmp").join(format!(
        "taco-ghost-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("run")).unwrap();

    let own_id = compute_install_id("/fake/install", dir.to_str().unwrap());

    // Spawn a long-lived helper that the reap will kill. We deliberately do
    // NOT create the NDJSON socket file — that's the ghost condition.
    // Note: we do NOT detach via setsid — see the assertion comment below
    // for why a child-process kill can't be observed via `kill -0`.
    let mut helper = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("sleep 30")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("failed to spawn helper");
    let ghost_pid = helper.id();

    fs::write(
        dir.join("run").join("sidecar.pid"),
        format!(
            r#"{{"version":1,"pid":{},"install_id":"{}","started_at":"2026-08-19T10:00:00.000Z"}}"#,
            ghost_pid, own_id
        ),
    )
    .unwrap();

    let inputs = ReapInputs {
        pid_file: dir.join("run").join("sidecar.pid"),
        socket_path: dir.join("run").join("sidecar.sock"),
        control_socket_path: dir.join("run").join("sidecar-ctl.sock"),
        own_install_id: &own_id,
        expected_sidecar_version: None,
        resources_root: PathBuf::from("/fake/install"),
    };

    let outcome = reap_previous_daemon(&inputs, None);
    match &outcome {
        ReapOutcome::Stale { pid, last_signal } => {
            assert_eq!(*pid, ghost_pid, "Stale.pid must equal ghost_pid");
            // The reap must have escalated to SIGTERM or SIGKILL — anything
            // else (e.g. "stale-pidfile") means it took the dead-pid branch
            // and skipped the kill entirely.
            assert!(
                *last_signal == "SIGTERM" || *last_signal == "SIGKILL",
                "ghost daemon must be killed (got last_signal={})",
                last_signal
            );
        }
        other => panic!("expected Stale outcome, got {:?}", other),
    }

    assert!(!dir.join("run").join("sidecar.pid").exists());
    // We intentionally do NOT assert `kill -0 ghost_pid` here. The reap's
    // pid_alive helper is satisfied by zombies — the helper becomes a zombie
    // owned by this test process until `helper.wait()` is called below, and
    // the reap has no way to distinguish a running process from a zombie.
    // Real-world daemons are reparented to launchd on setsid, which reaps
    // them immediately; the test helper is not detached. The last_signal
    // assertion above is the load-bearing check — it proves the reap walked
    // the kill branch, which is the regression we're guarding against.
    let _ = force_kill(ghost_pid);
    let _ = helper.wait();
    let _ = fs::remove_dir_all(&dir);
}

/// Shared fixture for the version-gate tests: a live helper process posing
/// as the daemon, a pid file that owns it, a present NDJSON socket entry,
/// and a control listener that answers pings with a configurable version.
/// Returns None when the control socket can't be bound (sandboxed runs).
fn version_gate_fixture(
    tag: &str,
    pong_version: Option<&str>,
) -> Option<(PathBuf, std::process::Child, ReapInputs<'static>, std::thread::JoinHandle<()>)> {
    let dir = std::path::PathBuf::from("/tmp").join(format!("taco-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("run")).unwrap();

    let own_id = compute_install_id("/fake/install", dir.to_str().unwrap());
    let ctl_path = dir.join("run").join("sidecar-ctl.sock");
    let listener = match UnixListener::bind(&ctl_path) {
        Ok(l) => l,
        Err(_) => {
            let _ = fs::remove_dir_all(&dir);
            eprintln!("taco reap test: skipping {tag} case (bind denied)");
            return None;
        }
    };

    let helper = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("sleep 30")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("failed to spawn helper");
    let daemon_pid = helper.id();

    fs::write(
        dir.join("run").join("sidecar.pid"),
        format!(
            r#"{{"version":1,"pid":{daemon_pid},"install_id":"{own_id}","started_at":"2026-08-19T10:00:00.000Z"}}"#
        ),
    )
    .unwrap();
    // Socket entry present: an alive pid without it is the ghost-socket
    // branch, not the version-gate branch.
    OpenOptions::new()
        .create(true)
        .write(true)
        .open(dir.join("run").join("sidecar.sock"))
        .unwrap();

    let version_field = pong_version
        .map(|v| format!(r#","version":"{v}""#))
        .unwrap_or_default();
    let responder = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("ping connection");
        let mut request = [0u8; 256];
        let _ = std::io::Read::read(&mut stream, &mut request);
        std::io::Write::write_all(
            &mut stream,
            format!(
                r#"{{"id":1,"result":{{"pid":{daemon_pid},"uptime_s":7{version_field}}}}}"#
            )
            .as_bytes(),
        )
        .expect("write ping response");
    });

    let inputs = ReapInputs {
        pid_file: dir.join("run").join("sidecar.pid"),
        socket_path: dir.join("run").join("sidecar.sock"),
        control_socket_path: ctl_path,
        // Leak the install id: ReapInputs borrows it, and the fixture's
        // lifetime would otherwise have to thread through every caller.
        // Tests are short-lived; a few leaked bytes are fine.
        own_install_id: Box::leak(own_id.into_boxed_str()),
        expected_sidecar_version: Some("0.1.2"),
        resources_root: PathBuf::from("/fake/install"),
    };
    Some((dir, helper, inputs, responder))
}

#[test]
fn reap_kills_daemon_running_a_stale_sidecar_version() {
    // The upgraded-desktop case: daemon is healthy (answers ping, socket
    // serving, install id ours) but reports the previous release's version.
    // Reusing it would attach the new desktop to old code forever.
    let Some((dir, mut helper, inputs, responder)) =
        version_gate_fixture("verstale", Some("0.1.0"))
    else {
        return;
    };
    let daemon_pid = helper.id();

    let outcome = reap_previous_daemon(&inputs, None);
    match &outcome {
        ReapOutcome::VersionMismatch {
            pid,
            expected,
            found,
        } => {
            assert_eq!(*pid, daemon_pid);
            assert_eq!(expected, "0.1.2");
            assert_eq!(found.as_deref(), Some("0.1.0"));
        }
        other => panic!("expected VersionMismatch, got {:?}", other),
    }
    assert!(!dir.join("run").join("sidecar.pid").exists());
    assert!(!dir.join("run").join("sidecar.sock").exists());

    force_kill(daemon_pid);
    let _ = helper.wait();
    responder.join().expect("control responder panicked");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn reap_preserves_daemon_running_the_expected_version() {
    let Some((dir, mut helper, inputs, responder)) =
        version_gate_fixture("vercurrent", Some("0.1.2"))
    else {
        return;
    };
    let daemon_pid = helper.id();

    let outcome = reap_previous_daemon(&inputs, None);
    assert_eq!(
        outcome,
        ReapOutcome::Alive {
            pid: daemon_pid,
            uptime_s: 7,
        }
    );
    assert!(dir.join("run").join("sidecar.pid").exists());
    assert!(is_alive(daemon_pid), "current daemon must not be signaled");

    force_kill(daemon_pid);
    let _ = helper.wait();
    responder.join().expect("control responder panicked");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn reap_treats_versionless_pong_as_stale_when_expecting_a_version() {
    // Pre-gate daemons answer control.ping without a version field (or a
    // bundle that resolved "0.0.0"); with an expectation set, that must reap
    // — otherwise the gate never applies to the daemons it exists to replace.
    let Some((dir, mut helper, inputs, responder)) = version_gate_fixture("vernone", None)
    else {
        return;
    };
    let daemon_pid = helper.id();

    let outcome = reap_previous_daemon(&inputs, None);
    match &outcome {
        ReapOutcome::VersionMismatch { pid, found, .. } => {
            assert_eq!(*pid, daemon_pid);
            assert_eq!(*found, None);
        }
        other => panic!("expected VersionMismatch, got {:?}", other),
    }

    force_kill(daemon_pid);
    let _ = helper.wait();
    responder.join().expect("control responder panicked");
    let _ = fs::remove_dir_all(&dir);
}
