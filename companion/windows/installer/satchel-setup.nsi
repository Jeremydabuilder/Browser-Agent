; Satchel for Windows - one installer for the current user (no administrator rights needed).
;
; It installs:
;   %LOCALAPPDATA%\Satchel\companion\   the companion that holds your API keys (encrypted with Windows DPAPI)
;   %LOCALAPPDATA%\Satchel\extension\   the Satchel browser extension, to load in Chrome or Edge
;   %LOCALAPPDATA%\Satchel\setup-guide.html   step-by-step help for adding the extension
; and registers the companion with Chrome and Edge (HKCU native messaging hosts), adds Start menu
; shortcuts, and an entry in Settings > Apps so it can be uninstalled normally.
;
; Your API keys are never inside this installer. After installing, the Finish page offers to open the
; key window (the same set-key.ps1 as before), which checks the key and saves it encrypted.
;
; Built by scripts/build.mjs:  makensis -DVERSION=x.y.z -DSTAGE=<staging folder> -DOUTFILE=<exe>
; Silent install for testing / IT:  SatchelSetup.exe /S   (skips the key and guide steps)

Unicode true
; The shipped installer is 32-bit (runs on every Windows 10/11 PC). Tests may pass -DTARGET=amd64-unicode.
!ifdef TARGET
  Target ${TARGET}
!endif
!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef STAGE
  !error "Pass -DSTAGE=<staging folder> (scripts/build.mjs does this)"
!endif
!ifndef OUTFILE
  !define OUTFILE "SatchelSetup.exe"
!endif

!define HOST_NAME "com.satchel.companion"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Satchel"
!define PS_EXE "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"

Name "Satchel"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Satchel"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "Satchel ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Satchel"
VIAddVersionKey "FileDescription" "Satchel setup (browser extension and Windows companion)"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Satchel"

!define MUI_ICON "${STAGE}\satchel.ico"
!define MUI_UNICON "${STAGE}\satchel.ico"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Set up Satchel"
!define MUI_WELCOMEPAGE_TEXT "Satchel is a sidebar assistant for Chrome and Edge.$\r$\n$\r$\nThis installs, for your Windows account only (no administrator rights needed):$\r$\n$\r$\n  - the Satchel companion, which keeps your AI key encrypted on this PC and starts by itself whenever Satchel needs it$\r$\n  - the Satchel extension files, ready to add to Chrome or Edge$\r$\n  - Start menu shortcuts to set your key, check the companion, and uninstall$\r$\n$\r$\nNothing runs in the background and nothing starts at login."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "Almost done: two short steps"
!define MUI_FINISHPAGE_TEXT "1. Add your Groq API key (free at console.groq.com/keys). A small window checks it and saves it encrypted for your Windows account.$\r$\n$\r$\n2. Add the Satchel extension to Chrome or Edge. The guide shows exactly where to click (about 1 minute).$\r$\n$\r$\nAfter that, click the Satchel icon in the browser toolbar. The AI works without starting anything."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Add my Groq key now"
!define MUI_FINISHPAGE_RUN_FUNCTION RunSetKey
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\setup-guide.html"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Show me how to add the extension to Chrome or Edge"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishShow
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  SetShellVarContext current
FunctionEnd

Function un.onInit
  SetShellVarContext current
FunctionEnd

; If a Groq key is already stored (reinstall / update), don't tick "Add my Groq key now".
Function FinishShow
  ${If} ${FileExists} "$INSTDIR\groq-key.dat"
    SendMessage $mui.FinishPage.Run ${BM_SETCHECK} ${BST_UNCHECKED} 0
    SendMessage $mui.FinishPage.Run ${WM_SETTEXT} 0 "STR:A Groq key is already stored. Tick to replace it"
  ${EndIf}
FunctionEnd

Function RunSetKey
  Exec '"${PS_EXE}" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\companion\set-key.ps1" -Provider groq'
FunctionEnd

Section "Satchel" SecMain
  SetOutPath "$INSTDIR"
  File "${STAGE}\satchel.ico"
  File "${STAGE}\setup-guide.html"

  ; Companion (also compatible with an earlier install made with install.cmd: same folder and names).
  DetailPrint "Installing the companion..."
  SetOutPath "$INSTDIR\companion"
  File "${STAGE}\companion\*.*"

  ; Extension: replace the folder so files removed in a newer version don't linger.
  ; Chrome/Edge reload an unpacked extension from disk when the browser restarts.
  DetailPrint "Installing the extension files..."
  RMDir /r "$INSTDIR\extension"
  SetOutPath "$INSTDIR\extension"
  File /r "${STAGE}\extension\*.*"

  ; Native messaging registration. The manifest lists only Satchel's fixed extension ID, and its
  ; "path" is relative to the manifest's own folder, so no user-specific path is baked into the file.
  DetailPrint "Registering the companion with Chrome and Edge..."
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\${HOST_NAME}" "" "$INSTDIR\companion\${HOST_NAME}.json"
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\${HOST_NAME}" "" "$INSTDIR\companion\${HOST_NAME}.json"

  ; Start menu (same folder and names as install.cmd, so re-running either one keeps a single set).
  ; SetOutPath sets the shortcuts' "Start in" folder.
  SetOutPath "$INSTDIR\companion"
  CreateDirectory "$SMPROGRAMS\Satchel"
  CreateShortcut "$SMPROGRAMS\Satchel\Satchel - Add the extension to Chrome or Edge.lnk" "$INSTDIR\setup-guide.html" "" "$INSTDIR\satchel.ico"
  CreateShortcut "$SMPROGRAMS\Satchel\Satchel - Set Groq key.lnk" "${PS_EXE}" '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\companion\set-key.ps1" -Provider groq' "$INSTDIR\satchel.ico"
  CreateShortcut "$SMPROGRAMS\Satchel\Satchel - Set OpenAI key.lnk" "${PS_EXE}" '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\companion\set-key.ps1" -Provider openai' "$INSTDIR\satchel.ico"
  CreateShortcut "$SMPROGRAMS\Satchel\Satchel - Check companion.lnk" "${PS_EXE}" '-NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File "$INSTDIR\companion\status.ps1"' "$INSTDIR\satchel.ico"
  CreateShortcut "$SMPROGRAMS\Satchel\Satchel - Uninstall.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\satchel.ico"
  ; The old PowerShell uninstall shortcut from install.cmd would leave the new files behind.
  Delete "$SMPROGRAMS\Satchel\Satchel - Uninstall companion.lnk"

  ; Settings > Apps entry.
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Satchel (browser extension and companion)"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Satchel"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\satchel.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ; School PCs sometimes lock PowerShell down; the companion can't run then. Say so now, not later.
  nsExec::ExecToStack '"${PS_EXE}" -NoLogo -NoProfile -NonInteractive -Command "$$ExecutionContext.SessionState.LanguageMode"'
  Pop $0
  Pop $1
  ${If} $0 != 0
  ${OrIfNot} $1 == "FullLanguage$\r$\n"
    DetailPrint "Warning: PowerShell check returned: $1"
    IfSilent +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "PowerShell looks restricted on this computer (often set by school IT).$\r$\n$\r$\nThe companion may be blocked, so AI features might not work. Everything else in Satchel still works. Run Start menu > Satchel > Satchel - Check companion for details."
  ${Else}
    DetailPrint "PowerShell can run the companion."
  ${EndIf}
  DetailPrint "Done. The companion starts automatically when Satchel needs it."
SectionEnd

Section "Uninstall"
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\${HOST_NAME}"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\${HOST_NAME}"
  DeleteRegKey HKCU "${UNINST_KEY}"
  RMDir /r "$SMPROGRAMS\Satchel"
  RMDir /r "$INSTDIR\companion"
  RMDir /r "$INSTDIR\extension"
  Delete "$INSTDIR\setup-guide.html"
  Delete "$INSTDIR\satchel.ico"
  Delete "$INSTDIR\uninstall.exe"

  ; Keys are kept unless you say otherwise (a silent uninstall always keeps them).
  ${If} ${FileExists} "$INSTDIR\*-key.dat"
    IfSilent keep_keys
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your stored API keys (Groq and OpenAI) from this PC?$\r$\n$\r$\nChoose No to keep them for a later reinstall." IDNO keep_keys
    Delete "$INSTDIR\groq-key.dat"
    Delete "$INSTDIR\openai-key.dat"
    keep_keys:
  ${EndIf}
  RMDir "$INSTDIR" ; only removed when empty (kept if keys or logs remain)

  IfSilent +2
  MessageBox MB_OK|MB_ICONINFORMATION "Satchel's files are removed.$\r$\n$\r$\nAlso remove the extension in your browser: open chrome://extensions or edge://extensions and click Remove on Satchel."
SectionEnd
