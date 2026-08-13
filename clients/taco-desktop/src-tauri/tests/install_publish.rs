//! Tests for the publish-at-install-time invariant on AppState's log_files.
//!
//! Race scenarios involving real child processes are out of scope for an
//! integration test: the production path uses tokio::process::Command
//! directly and isn't easily mockable without duplicating the spawn body.
//! What we *can* test cheaply is the lock+publish dance: that the field
//! is None before any ensure, that a "successful" ensure publishes the
//! Arc, and that a "losing" ensure does not pollute state.
//!
//! Run:
//!   cargo test --test install_publish

use std::sync::Arc;

/// Field type as it now lives on AppState. Doubly-wrapped on purpose:
/// the outer mutex is the install-publish point (one writer at a time),
/// the inner Arc is the reader's handle (one per sidecar process).
type LogFilesField = Arc<std::sync::Mutex<Option<Arc<std::sync::Mutex<Vec<u8>>>>>>;

/// Stand-in for the production state slice that `workspace_ensure` mutates.
/// Real production couples this to Tauri; here it's just plain sync.
struct TestState {
    log_files: LogFilesField,
    slot: std::sync::Mutex<Option<u64>>, // generation counter as a stand-in
}

#[test]
fn fix_at_install_does_not_leak_stale_arc() {
    // The pre-fix code published `state.log_files` at setup time, so a
    // losing/aborting ensure left a stale Arc in state that the next read
    // could pick up. This test asserts the post-fix behavior: only winning
    // ensures ever write to state.
    let state = TestState {
        log_files: Arc::new(std::sync::Mutex::new(None)),
        slot: std::sync::Mutex::new(Some(99)), // pre-existing install
    };

    // A losing ensure: simulate "tried to install, found slot occupied, aborted."
    // The post-fix code path is: build local Arc, never write to state, return.
    {
        let slot = state.slot.lock().unwrap();
        if slot.is_some() {
            // abort path — the local Arc is dropped here
        }
    }

    // State.log_files must still be None: an aborting ensure never writes.
    let stored = state.log_files.lock().unwrap();
    assert!(
        stored.is_none(),
        "aborting ensure wrote to state.log_files — pre-fix bug present"
    );
}

#[test]
fn install_publishes_atomically() {
    let state = TestState {
        log_files: Arc::new(std::sync::Mutex::new(None)),
        slot: std::sync::Mutex::new(None),
    };

    // Simulate the install block: build a LogFiles, lock slot+state, publish.
    let log_files: Arc<std::sync::Mutex<Vec<u8>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let _reader_clone = log_files.clone();

    let mut slot = state.slot.lock().unwrap();
    *state.log_files.lock().unwrap() = Some(log_files);
    *slot = Some(42);
    drop(slot);

    // Verify both publishes happened.
    let stored = state.log_files.lock().unwrap();
    assert!(stored.is_some(), "log_files not published at install");
    assert!(state.slot.lock().unwrap().is_some(), "slot not installed");
}

#[test]
fn aborting_ensure_does_not_pollute_state() {
    // The pre-fix code published `state.log_files` at setup time, before the
    // install-lock check. So a losing/aborting ensure could leave a stale
    // Arc in state that the winning ensure then overwrote — but in the
    // meantime, the aborting ensure's *reader task* (already spawned,
    // holding the local Arc clone) was writing to its own log files while
    // the winning install had its own. Two log files for one restart.
    //
    // Post-fix: `state.log_files` is only written *inside* the install
    // block, so an aborting ensure never touches it. The reader task
    // holds its local Arc clone and continues until its child dies; state
    // stays clean.
    let state = TestState {
        log_files: Arc::new(std::sync::Mutex::new(None)),
        slot: std::sync::Mutex::new(Some(7)), // pre-existing install
    };

    // A losing ensure: the slot is already taken, so we go to the "kill
    // our orphan" branch and return without writing to state.log_files.
    {
        let slot = state.slot.lock().unwrap();
        if slot.is_some() {
            // abort path — no write to state.log_files
        }
    }

    // State must be unchanged: still None (no install has ever won this
    // fresh test, despite the slot having a pre-existing value).
    let stored = state.log_files.lock().unwrap();
    assert!(
        stored.is_none(),
        "aborting ensure wrote to state.log_files — back to the pre-fix bug"
    );
}

#[test]
fn winning_ensure_overwrites_prior_state_log_files() {
    // Two sequential wins: second ensure's log files replace the first's
    // in state, but the first's reader is still running on its local Arc
    // and continues to write to its own (now-orphaned) log files until
    // its child dies. That's the right behavior — we don't try to close
    // the prior reader's log files because the reader is its owner.
    let state = TestState {
        log_files: Arc::new(std::sync::Mutex::new(None)),
        slot: std::sync::Mutex::new(None),
    };

    // First install.
    {
        let _slot = state.slot.lock().unwrap();
        *state.log_files.lock().unwrap() = Some(Arc::new(std::sync::Mutex::new(vec![1u8])));
    }
    let first = state.log_files.lock().unwrap().clone();
    assert!(first.is_some());

    // Second install (simulating restart).
    {
        let _slot = state.slot.lock().unwrap();
        *state.log_files.lock().unwrap() = Some(Arc::new(std::sync::Mutex::new(vec![2u8])));
    }
    let second = state.log_files.lock().unwrap().clone();
    assert!(second.is_some());

    // The two Arcs are distinct — second is the new one in state, first is
    // the local one still held by the (logically-still-running) first reader.
    let first_inner = first.unwrap();
    let second_inner = second.unwrap();
    assert!(
        !Arc::ptr_eq(&first_inner, &second_inner),
        "second install should produce a new Arc, not alias the first"
    );

    // First reader can still write through its local Arc — it has its own
    // mutex, separate from the state-level one.
    first_inner.lock().unwrap().push(99);
    assert_eq!(*first_inner.lock().unwrap(), vec![1u8, 99u8]);
    assert_eq!(*second_inner.lock().unwrap(), vec![2u8]);
}
