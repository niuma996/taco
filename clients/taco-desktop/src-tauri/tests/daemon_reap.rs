//! Tests for the pid-file reap path. Mirrors `packages/cli/tests/installId.test.ts`
//! on the TS side; if either drifts the desktop reap will silently miss its own
//! daemon (or kill a sibling install's).
//!
//! Run:
//!   cargo test --test daemon_reap

#![cfg(unix)]

use std::path::Path;
use taco_desktop_lib::daemon_reap_test::*;

#[test]
fn golden_vector_matches_typescript() {
    // The TS counterpart computes:
    //   sha256("/repo/packages/sidecar/src" + "\0" + "/home/dev/.taco")
    //     .slice(0, 16)
    // If this test fails after a code change, BOTH the TS computeInstallId
    // and the Rust compute_install_id were updated — make sure that's the
    // intent before relaxing the assertion.
    let id = compute_install_id("/repo/packages/sidecar/src", "/home/dev/.taco");
    assert_eq!(id, "c8ffd7d5d75fcb04");
}

#[test]
fn compute_install_id_differs_per_input() {
    let a = compute_install_id("/install-a/sidecar", "/Users/x/.taco");
    let b = compute_install_id("/install-b/sidecar", "/Users/x/.taco");
    let c = compute_install_id("/install-a/sidecar", "/Users/y/.taco");
    assert_ne!(a, b, "different resources roots must produce different ids");
    assert_ne!(a, c, "different taco homes must produce different ids");
    assert_eq!(a.len(), 16);
}

#[test]
fn parse_pid_file_accepts_json_record() {
    let raw = r#"{"version":1,"pid":4242,"install_id":"abcd1234ef567890","started_at":"2026-08-19T10:00:00.000Z"}"#;
    let parsed = parse_pid_file(raw).expect("must parse");
    assert_eq!(parsed.pid, 4242);
    assert_eq!(parsed.install_id.as_deref(), Some("abcd1234ef567890"));
    assert_eq!(
        parsed.started_at.as_deref(),
        Some("2026-08-19T10:00:00.000Z")
    );
    assert_eq!(parsed.sidecar_version, None);
}

#[test]
fn parse_pid_file_surfaces_sidecar_version() {
    let raw = r#"{"version":1,"pid":4242,"install_id":"abcd1234ef567890","started_at":"2026-08-19T10:00:00.000Z","sidecar_version":"0.1.2"}"#;
    let parsed = parse_pid_file(raw).expect("must parse");
    assert_eq!(parsed.sidecar_version.as_deref(), Some("0.1.2"));
}

#[test]
fn pong_version_current_gate_semantics() {
    // No expectation → liveness only (pre-gate behavior).
    assert!(pong_version_current(Some("0.1.0"), None));
    assert!(pong_version_current(None, None));
    // Expectation set → exact match required.
    assert!(pong_version_current(Some("0.1.2"), Some("0.1.2")));
    assert!(!pong_version_current(Some("0.1.0"), Some("0.1.2")));
    // Pre-gate daemons (no version on the wire) never satisfy an expectation.
    assert!(!pong_version_current(None, Some("0.1.2")));
}

#[test]
fn parse_pong_extracts_pid_uptime_and_version() {
    let pong = parse_pong(r#"{"id":1,"result":{"version":"0.1.2","protocol":1,"uptime_s":42,"pid":4242}}"#)
        .expect("must parse");
    assert_eq!(pong.pid, 4242);
    assert_eq!(pong.uptime_s, 42);
    assert_eq!(pong.version.as_deref(), Some("0.1.2"));

    let legacy = parse_pong(r#"{"id":1,"result":{"pid":4242}}"#).expect("must parse");
    assert_eq!(legacy.uptime_s, 0);
    assert_eq!(legacy.version, None);

    assert!(parse_pong(r#"{"id":1,"result":{}}"#).is_none());
    assert!(parse_pong("not json").is_none());
}

#[test]
fn parse_pid_file_accepts_legacy_bare_int() {
    let parsed = parse_pid_file("4242\n").expect("must parse legacy");
    assert_eq!(parsed.pid, 4242);
    assert!(parsed.install_id.is_none());
    assert!(parsed.started_at.is_none());
}

#[test]
fn parse_pid_file_returns_none_on_garbage() {
    assert!(parse_pid_file("").is_none());
    assert!(parse_pid_file("   \n").is_none());
    assert!(parse_pid_file("not a pid").is_none());
    assert!(parse_pid_file("-5").is_none());
    assert!(parse_pid_file("0").is_none());
}

#[test]
fn parse_pid_file_rejects_unknown_schema_version() {
    let raw = r#"{"version":2,"pid":4242,"install_id":"abcd1234ef567890","started_at":"2026-08-19T10:00:00.000Z"}"#;
    assert!(parse_pid_file(raw).is_none());
}

#[test]
fn parse_pid_file_rejects_missing_pid() {
    let raw = r#"{"version":1,"install_id":"abcd1234ef567890","started_at":"2026-08-19T10:00:00.000Z"}"#;
    assert!(parse_pid_file(raw).is_none());
}

#[test]
fn daemon_runtime_paths_layout() {
    let runtime_dir = Path::new("/Users/x/.taco-dev/run");
    let (pid, sock, ctl) = daemon_runtime_paths(runtime_dir);
    assert_eq!(pid, Path::new("/Users/x/.taco-dev/run/sidecar.pid"));
    assert_eq!(sock, Path::new("/Users/x/.taco-dev/run/sidecar.sock"));
    assert_eq!(ctl, Path::new("/Users/x/.taco-dev/run/sidecar-ctl.sock"));
}
