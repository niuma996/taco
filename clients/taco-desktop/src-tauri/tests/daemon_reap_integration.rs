//! Integration tests for `reap_previous_daemon` against synthetic disk state.
//!
//! These tests don't spawn a real daemon -- they write a pid file + sockets to
//! a tmp directory, then call reap and assert the outcome + post-state.
//!
//! Run:
//!   cargo test --test daemon_reap_integration

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use taco_desktop_lib::daemon_reap_test::{
    compute_install_id, daemon_paths, reap_previous_daemon, ReapInputs,
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
        let (pid, sock, ctl) = daemon_paths(&self.dir);
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
    let outcome = reap_previous_daemon(&tmp.build_inputs(&id));
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

    let outcome = reap_previous_daemon(&tmp.build_inputs(&own_id));
    match outcome {
        taco_desktop_lib::daemon_reap_test::ReapOutcome::Reaped { pid, .. } => {
            assert_eq!(pid, 999_999);
        }
        other => panic!("expected Reaped, got {:?}", other),
    }
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

    let outcome = reap_previous_daemon(&tmp.build_inputs(&own_id));
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

    let outcome = reap_previous_daemon(&tmp.build_inputs(&own_id));
    match outcome {
        taco_desktop_lib::daemon_reap_test::ReapOutcome::Reaped { pid, .. } => {
            assert_eq!(pid, 999_997);
        }
        other => panic!("expected Reaped, got {:?}", other),
    }
    assert!(!pid_file.exists());
    assert!(!sock.exists());
    assert!(!ctl.exists());
}

#[test]
fn reap_returns_unparseable_when_pid_file_is_corrupt() {
    let tmp = TmpHome::new("corrupt");
    let own_id = compute_install_id("/fake/install", tmp.dir.to_str().unwrap());
    tmp.write_pid("not a pid, not json, just garbage\n");
    let outcome = reap_previous_daemon(&tmp.build_inputs(&own_id));
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
    let outcome = reap_previous_daemon(&tmp.build_inputs(&own_id));
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
    // Sandbox / macOS SUN_LEN may deny the bind -- skip the alive-listener
    // assertion rather than fail the suite. The "reap doesn't reap a
    // foreign daemon" + "idempotent when nothing to do" tests already
    // cover the reap-not-killing-foreign case.
    let ctl_path = dir.join("run").join("sidecar-ctl.sock");
    let listener = match UnixListener::bind(&ctl_path) {
        Ok(l) => Some(l),
        Err(_) => {
            let _ = fs::remove_dir_all(&dir);
            eprintln!("taco reap test: skipping alive-listener case (bind denied)");
            return;
        }
    };
    let _ = listener;
    let pid = std::process::id();
    let pid_file = dir.join("run").join("sidecar.pid");
    fs::write(
        &pid_file,
        format!(
            r#"{{"version":1,"pid":{pid},"install_id":"{own_id}","started_at":"2026-08-19T10:00:00.000Z"}}"#
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

    // Should not panic. Reaping our own pid would actually kill the test
    // process, so we trust the unit-tested ping_control_socket + pid_alive
    // code paths to do the right thing without exercising the kill here.
    let _outcome = reap_previous_daemon(&inputs);

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
    let first = reap_previous_daemon(&ins);
    let second = reap_previous_daemon(&ins);
    assert!(matches!(
        first,
        taco_desktop_lib::daemon_reap_test::ReapOutcome::Reaped { .. }
    ));
    assert_eq!(
        second,
        taco_desktop_lib::daemon_reap_test::ReapOutcome::NoPidFile
    );
}
