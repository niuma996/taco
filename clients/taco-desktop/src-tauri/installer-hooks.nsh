; Taco NSIS installer hooks.
;
; Wired in via `bundle.windows.nsis.installerHooks` in tauri.conf.json.
; `NSIS_HOOK_PREINSTALL` is inserted at the very top of the installer's
; `Section Install` — before any file is copied — which is exactly where a
; stale daemon's write lock on `taco-sidecar-node.exe` must be cleared, or the
; copy aborts with "Error opening file for writing".
;
; Why this hook exists: installing over a running install leaves the sidecar
; daemon (`taco-sidecar-node.exe`, spawned either by the desktop or by the
; `TacoSidecar` scheduled task) holding a write lock on its own binary.
; Tauri's built-in `CheckIfAppIsRunning` only handles the main `TACO.exe`, so
; the copy of `taco-sidecar-node.exe` is the first thing to fail.
;
; Ordering matters: the desktop runs a reconnect loop (500ms → 5s backoff,
; see tacoClient.ts) that RESPAWNS the daemon when it dies. The UI must be
; killed BEFORE the daemon — otherwise the UI resurrects the daemon while we
; wait and the lock comes back before the copy runs. Tauri's own TACO.exe
; check runs *after* this hook (too late, and it would overlap a respawn), so
; the UI is handled here, first; Tauri's check then finds nothing and skips
; its prompt.

!macro NSIS_HOOK_PREINSTALL
  ; --- 1. Close the desktop UI (TACO.exe) first, prompting like Tauri does ---
  ; Reuses the installer's own localized strings; StrReplace fills the
  ; {{product_name}} placeholder. Mirrors the template's CheckIfAppIsRunning.
  nsis_tauri_utils::StrReplace "$(appRunningOkKill)" "{{product_name}}" "${PRODUCTNAME}"
  Pop $R2
  nsis_tauri_utils::StrReplace "$(failedToKillApp)" "{{product_name}}" "${PRODUCTNAME}"
  Pop $R3
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::FindProcessCurrentUser "TACO.exe"
  !else
    nsis_tauri_utils::FindProcess "TACO.exe"
  !endif
  Pop $R0
  ${If} $R0 = 0
    IfSilent taco_preinstall_kill_ui 0
    ${IfThen} $PassiveMode != 1 ${|} MessageBox MB_OKCANCEL $R2 IDOK taco_preinstall_kill_ui IDCANCEL taco_preinstall_cancel_ui ${|}
    taco_preinstall_kill_ui:
      !if "${INSTALLMODE}" == "currentUser"
        nsis_tauri_utils::KillProcessCurrentUser "TACO.exe"
      !else
        nsis_tauri_utils::KillProcess "TACO.exe"
      !endif
      Pop $R0
      Sleep 500
      ${If} $R0 = 0
      ${OrIf} $R0 = 2
        Goto taco_preinstall_ui_done
      ${Else}
        Abort $R3
      ${EndIf}
    taco_preinstall_cancel_ui:
      Abort
    taco_preinstall_ui_done:
  ${EndIf}

  ; --- 2. Stop the TacoSidecar scheduled task instance ---
  ; No-op (exit 1) when the task isn't running. The task is ONSTART, so it
  ; does not auto-restart on exit — this is belt-and-braces on top of the kill
  ; below and just ends the task's process tree a little more gracefully.
  nsExec::ExecToLog 'schtasks /End /TN TacoSidecar'
  Pop $0

  ; --- 3. Kill any lingering daemon node binary ---
  ; This is the process that holds the write lock on
  ; `$INSTDIR\taco-sidecar-node.exe`. Kill* returns 0=killed / 1=error /
  ; 2=not-found; every outcome is fine to continue from, so the result is
  ; ignored. Killing by image name covers every spawner (desktop, schtasks,
  ; manual `taco start`) because they all run the same binary.
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::KillProcessCurrentUser "taco-sidecar-node.exe"
  !else
    nsis_tauri_utils::KillProcess "taco-sidecar-node.exe"
  !endif
  Pop $0

  ; --- 4. Settle ---
  ; Give Windows a moment to release the file handle (and let any AV finish
  ; scanning the just-terminated binary) before the copy begins.
  Sleep 1500
!macroend
