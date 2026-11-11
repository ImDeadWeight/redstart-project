; =============================================================================
; Redstart Nest installer hooks (daemon split T3)
; =============================================================================
; Inserted into Tauri's NSIS template (tauri.bundle.conf.json →
; bundle.windows.nsis.installerHooks). Two jobs:
;
; 1. THE BRIDGE. Releases up to 1.0.0-alpha.6 (and the T1 bridge release)
;    were electron-builder installs. The first Tauri installer reaches them
;    through electron-updater, which runs it silently. It must replace that
;    install, not sit beside it, or two tray apps would fight over port
;    19083. So: run the Electron install's own uninstaller silently (it keeps
;    user data; electron-builder's deleteAppDataOnUninstall is off), remove its
;    login item, and install into the SAME directory, so taskbar pins and
;    shortcuts keep pointing at "Redstart Nest.exe" where it always was.
;    %APPDATA%\redstart (accounts, settings, secrets-key.json) is never
;    touched by either uninstaller.
;
; 2. What electron-updater asks of the installer it runs: `--force-run`
;    means "start the app when done" (its Restart to update). Tauri's own
;    flag for that is /R, so --force-run is honoured here.
;
; Registry facts this relies on (read from a real alpha.6 install):
;   electron-builder's per-user uninstall key is a GUID derived from the
;   appId (com.redstart.nest), the same on every machine. InstallLocation is
;   empty there; QuietUninstallString is "<dir>\Uninstall Redstart Nest.exe"
;   /currentuser /S. Its login item is HKCU Run "electron.app.Redstart Nest".
; =============================================================================

!define REDSTART_ELECTRON_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\09e3ae85-f70e-5de1-8268-af6ccbf16b9b"
!define REDSTART_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R0 HKCU "${REDSTART_ELECTRON_UNINSTALL_KEY}" "QuietUninstallString"
  StrCmp $R0 "" redstart_bridge_done

  DetailPrint "Replacing the earlier Redstart Nest (Electron) install"
  ; $R0 = "<path>" /currentuser /S. Take the quoted path.
  StrCpy $R1 $R0 "" 1
  StrCpy $R2 0
  redstart_bridge_scan:
    StrCpy $R3 $R1 1 $R2
    StrCmp $R3 '"' redstart_bridge_found
    StrCmp $R3 "" redstart_bridge_done
    IntOp $R2 $R2 + 1
    Goto redstart_bridge_scan
  redstart_bridge_found:
  StrCpy $R4 $R1 $R2
  ${GetParent} $R4 $R5
  IfFileExists "$R4" 0 redstart_bridge_cleanup

  ; _?= runs the uninstaller in place, so ExecWait really waits (an NSIS
  ; uninstaller otherwise copies itself to %TEMP% and returns at once).
  ExecWait '"$R4" /currentuser /S _?=$R5' $R6
  DetailPrint "Electron uninstaller exited with $R6"
  Delete "$R4"

  ; Install where the Electron app was. Everything after this hook (files,
  ; shortcuts, the uninstall entry) uses $INSTDIR. The template's SetOutPath
  ; already created the default directory; remove it if it is still empty
  ; (plain RMDir never deletes contents).
  RMDir $INSTDIR
  StrCpy $INSTDIR $R5
  SetOutPath $INSTDIR

  redstart_bridge_cleanup:
  ; Whatever the uninstaller left: its login item and its uninstall entry.
  ; The shell writes its own Run value at first start if start-at-login is on.
  DeleteRegValue HKCU "${REDSTART_RUN_KEY}" "electron.app.Redstart Nest"
  DeleteRegKey HKCU "${REDSTART_ELECTRON_UNINSTALL_KEY}"

  redstart_bridge_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Have Explorer drop its cached icons. Every install lands at the same
  ; "Redstart Nest.exe" path (deliberately, so pins and shortcuts survive), and
  ; Windows caches icons by path, so a release that changes the icon (alpha.11's
  ; mascot) otherwise kept showing the old one on the taskbar and in Start.
  ; SHCNE_ASSOCCHANGED (0x08000000) with SHCNF_IDLIST (0) is the documented way.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ; electron-updater's "start it again when you're done".
  ClearErrors
  ${GetOptions} $CMDLINE "--force-run" $R0
  ${IfNot} ${Errors}
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; A real uninstall (not the uninstall step of an update) takes the login
  ; item with it. User data in %APPDATA%\redstart stays, as it always has.
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "${REDSTART_RUN_KEY}" "Redstart Nest"
  ${EndIf}
!macroend
