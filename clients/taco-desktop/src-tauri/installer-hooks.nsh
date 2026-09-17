; Taco NSIS installer hooks — wired in via bundle.windows.nsis.installerHooks.
;
; NSIS_HOOK_PREINSTALL runs at the top of Section Install, before any File
; copy. Installing over a running install fails there: the sidecar daemon
; (`taco-sidecar-node.exe`, spawned by the desktop or the `TacoSidecar`
; scheduled task) holds a write lock on its own binary, and Tauri's built-in
; `CheckIfAppIsRunning` only covers `TACO.exe`.
;
; Order matters: the desktop's reconnect loop (500ms → 5s backoff, see
; tacoClient.ts) RESPAWNS the daemon when it dies, so the UI must die BEFORE
; the daemon or it resurrects the lock mid-install. After the kills we poll
; until the process is actually gone — a fixed sleep loses to slow AV handle
; release — and abort with an actionable message if it refuses to die.

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
  ; No-op (exit 1) when the task isn't running. The task is ONLOGON, so it
  ; does not auto-restart on exit — this is belt-and-braces on top of the kill
  ; below and just ends the task's process tree a little more gracefully.
  nsExec::ExecToLog 'schtasks /End /TN TacoSidecar'
  Pop $0

  ; --- 3. Kill any lingering daemon node binary ---
  ; This is the process that holds the write lock on
  ; `$INSTDIR\taco-sidecar-node.exe`. Kill unconditionally (all users),
  ; NOT the current-user variant: daemons registered by older builds via
  ; `schtasks /RL HIGHEST` (or ONSTART-as-SYSTEM) run under a token
  ; KillProcessCurrentUser cannot reach — the source of the intermittent
  ; "Error opening file for writing" on upgrade. `taskkill /F /IM` is a
  ; belt-and-braces fallback. Both exit codes are ignored (the poll below
  ; is what actually decides); 0=killed / 1=error / 2=not-found are all
  ; fine to continue from. The image name ships only with Taco, so an
  ; image-name kill has no collateral damage.
  nsis_tauri_utils::KillProcess "taco-sidecar-node.exe"
  Pop $0
  nsExec::ExecToLog 'taskkill /F /IM taco-sidecar-node.exe'
  Pop $0

  ; --- 4. Wait until the daemon is actually gone ---
  ; A fixed sleep loses to slow AV handle release. Poll every 500ms, up to
  ; 10s; if the process still answers, abort with an actionable message
  ; instead of letting the copy fail with NSIS's generic Abort/Retry/Ignore
  ; dialog that hides the real cause.
  StrCpy $R4 0
  taco_preinstall_wait_daemon:
    nsis_tauri_utils::FindProcess "taco-sidecar-node.exe"
    Pop $R0
    ${If} $R0 <> 0
      Goto taco_preinstall_daemon_gone
    ${EndIf}
    IntOp $R4 $R4 + 1
    ${If} $R4 >= 20
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONSTOP "Taco Setup could not stop the Taco background service (taco-sidecar-node.exe).$\r$\n$\r$\nPlease quit Taco, end taco-sidecar-node.exe in Task Manager, then run this installer again."
      ${EndIf}
      Abort
    ${EndIf}
    Sleep 500
    Goto taco_preinstall_wait_daemon
  taco_preinstall_daemon_gone:
  ; One more beat for the OS/AV to release the file handle before the copy begins.
  Sleep 500
!macroend
