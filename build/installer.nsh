; Included by electron-builder's NSIS script (package.json build.nsis.include).
; Always install for the current user only: no "all users" page and no admin
; prompt. App data stays in %APPDATA%\Denarii either way.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
