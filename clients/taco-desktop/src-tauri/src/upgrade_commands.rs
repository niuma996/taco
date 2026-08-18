//! Tauri command layer for the desktop's upgrade-marker check + apply step.
//!
//! The marker file is shared per-`$TACO_HOME` across every installation of
//! the sidecar (npm platform pkg, this app's bundled sidecar, dev repo
//! source), so both `upgrade_marker_present` and `upgrade_apply` are scoped
//! to the installation this desktop actually manages.

use std::path::Path;
use tauri::AppHandle;

use crate::paths::{resolve_taco_home, strip_win_verbatim};
use crate::sidecar_launcher::{resolve_install_launcher_via_handle, resolve_sidecar};

/// Returns true if a `taco upgrade` was staged FOR THIS INSTALLATION and
/// the daemon's orchestrator will shut itself down on its next recheck
/// (the UI's reconnect loop checks this between attempts and runs `taco
/// upgrade --apply` before re-ensuring).
///
/// An existence check alone made the desktop apply upgrades that belong to
/// a different installation, so we parse the marker and compare its
/// `live_dir` against the root this desktop actually manages (the same
/// value the spawned daemon receives as TACO_SIDECAR_RESOURCES). When the
/// managed root can't be determined we report false — never apply an
/// upgrade we can't attribute.
#[tauri::command]
pub async fn upgrade_marker_present(app: AppHandle) -> Result<bool, String> {
    let home = resolve_taco_home(&app)?;
    let Ok(raw) = std::fs::read_to_string(home.join("upgrade-marker.json")) else {
        return Ok(false); // missing or unreadable → not pending
    };
    let Ok(marker) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Ok(false); // malformed → the writer's owner will re-stage
    };
    let Some(live_dir) = marker.get("live_dir").and_then(|v| v.as_str()) else {
        return Ok(false);
    };
    let managed_root = match resolve_sidecar(&app).ok().and_then(|r| r.resources_root) {
        Some(root) => root,
        None => return Ok(false),
    };
    Ok(same_install_path(Path::new(live_dir), &managed_root))
}

/// Filesystem-free comparison of two install-root paths (no canonicalize:
/// the marker's live_dir may legitimately not exist mid-swap). Strips the
/// Windows verbatim prefix and trailing separators; case-insensitive on
/// Windows because NTFS is.
fn same_install_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let stripped = strip_win_verbatim(p);
        let s = stripped.to_string_lossy();
        let s = s.trim_end_matches(['/', '\\']);
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s.to_string()
        }
    };
    norm(a) == norm(b)
}

/// Run `taco upgrade --apply` via the bundled launcher (the same one
/// `ensure_daemon_installed` uses for the first-run `taco install`).
/// Best-effort: a non-zero exit propagates as a String error so the
/// frontend's reconnect loop can surface it without aborting the retry
/// schedule. The CLI handles the atomic swap + marker clear itself;
/// the Tauri command layer only spawns the binary.
#[tauri::command]
pub async fn upgrade_apply(app: AppHandle) -> Result<String, String> {
    let Some(launcher) = resolve_install_launcher_via_handle(&app) else {
        return Err("taco launcher not found; cannot run upgrade --apply".into());
    };
    let taco_home = resolve_taco_home(&app)?;
    let mut cmd = std::process::Command::new(&launcher.program);
    for arg in &launcher.prefix_args {
        cmd.arg(arg);
    }
    cmd.arg("upgrade").arg("--apply");
    cmd.env("TACO_HOME", &taco_home);
    for (key, value) in &launcher.env {
        cmd.env(key, value);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("failed to spawn taco upgrade --apply: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "taco upgrade --apply exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim_end().to_string())
}