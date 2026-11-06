; =============================================================================
; Redstart Twig installer hooks
; =============================================================================
; Inserted into Tauri's NSIS template (tauri.bundle.conf.json →
; bundle.windows.nsis.installerHooks).
;
; REPLACING AN ELECTRON TWIG. Releases up to 1.0.0-alpha.9 shipped Twig as an
; electron-builder install. Electron Twig never updated itself, so the user
; runs this installer by hand, once. It must replace that install rather than
; sit beside it as a second "Redstart Twig" in the Start menu. So: run the
; Electron install's own uninstaller silently (it keeps user data;
; electron-builder's deleteAppDataOnUninstall is off), and for a per-user
; install, install into the SAME directory, so taskbar pins and shortcuts keep
; pointing at "Redstart Twig.exe" where it always was. The state folder,
; %APPDATA%\redstart-twig-windows (the folder grant, twig-mcp.json), is never
; touched by either uninstaller.
;
; electron-builder's uninstall key is a GUID derived from the appId: UUIDv5 of
; "com.redstart.twig" in its namespace 50e065bc-3134-11e6-9bab-38c9862bdaf3,
; the same derivation that reproduces Nest's known key
; (09e3ae85-f70e-5de1-8268-af6ccbf16b9b for com.redstart.nest).
;
; Electron Twig's installer let the user choose "for all users" too (perMachine
; unset, oneClick off). That install is under HKLM and Program Files. Its
; uninstaller asks for elevation itself (a UAC prompt). This per-user
; installer still installs to its own per-user folder in that case. If the
; prompt is declined, both stay installed; the old one is then the user's to
; remove from Settings → Apps.
; =============================================================================

!define TWIG_ELECTRON_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\347afa00-6d01-59bd-b1c4-8860b58f9de1"

!macro NSIS_HOOK_PREINSTALL
  ; ---- a per-user Electron install: replace it in place ----
  ReadRegStr $R0 HKCU "${TWIG_ELECTRON_UNINSTALL_KEY}" "QuietUninstallString"
  StrCmp $R0 "" twig_check_machine
  DetailPrint "Replacing the earlier Redstart Twig (Electron) install"
  ; $R0 = "<path>" /currentuser /S. Take the quoted path.
  StrCpy $R1 $R0 "" 1
  StrCpy $R2 0
  twig_user_scan:
    StrCpy $R3 $R1 1 $R2
    StrCmp $R3 '"' twig_user_found
    StrCmp $R3 "" twig_user_cleanup
    IntOp $R2 $R2 + 1
    Goto twig_user_scan
  twig_user_found:
  StrCpy $R4 $R1 $R2
  ${GetParent} $R4 $R5
  IfFileExists "$R4" 0 twig_user_cleanup
  ; _?= runs the uninstaller in place, so ExecWait really waits (an NSIS
  ; uninstaller otherwise copies itself to %TEMP% and returns at once).
  ExecWait '"$R4" /currentuser /S _?=$R5' $R6
  DetailPrint "Electron uninstaller exited with $R6"
  Delete "$R4"
  ; Install where the Electron app was. The template's SetOutPath already
  ; created the default directory; remove it if it is still empty.
  RMDir $INSTDIR
  StrCpy $INSTDIR $R5
  SetOutPath $INSTDIR
  twig_user_cleanup:
  DeleteRegKey HKCU "${TWIG_ELECTRON_UNINSTALL_KEY}"

  ; ---- an all-users Electron install: its uninstaller elevates itself ----
  twig_check_machine:
  ReadRegStr $R0 HKLM "${TWIG_ELECTRON_UNINSTALL_KEY}" "QuietUninstallString"
  StrCmp $R0 "" twig_done
  DetailPrint "Removing the earlier all-users Redstart Twig (Electron) install"
  ; $R0 = "<path>" /allusers /S.
  StrCpy $R1 $R0 "" 1
  StrCpy $R2 0
  twig_machine_scan:
    StrCpy $R3 $R1 1 $R2
    StrCmp $R3 '"' twig_machine_found
    StrCmp $R3 "" twig_done
    IntOp $R2 $R2 + 1
    Goto twig_machine_scan
  twig_machine_found:
  StrCpy $R4 $R1 $R2
  ${GetParent} $R4 $R5
  IfFileExists "$R4" 0 twig_done
  ExecWait '"$R4" /allusers /S _?=$R5' $R6
  DetailPrint "Electron uninstaller exited with $R6"

  twig_done:
!macroend
