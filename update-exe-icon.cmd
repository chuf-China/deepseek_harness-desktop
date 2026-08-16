@echo off
setlocal

rem One-click: patch DeepSeek Harness.exe with the whale icon (no repackaging, no reinstall).
rem Usage: QUIT the running DeepSeek Harness first (tray icon -> Exit), then double-click this file.
rem Requires: rcedit from the electron-builder cache, and assets\icon.ico.

set "RCEDIT=%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\rcedit-x64.exe"
set "ICON=%~dp0assets\icon.ico"
set "INSTALLED=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"

echo ============================================================
echo   DeepSeek Harness icon updater  (whale logo, no repackaging)
echo ============================================================
echo.

if not exist "%RCEDIT%" (
    echo [ERROR] rcedit not found: %RCEDIT%
    echo         Run "npm run dist" once to populate the electron-builder cache.
    goto :end
)
if not exist "%ICON%" (
    echo [ERROR] icon not found: %ICON%
    goto :end
)

echo [1/2] Patch installed app exe:
echo        %INSTALLED%
if not exist "%INSTALLED%" (
    echo        [SKIP] installed app not found
    goto :skip_installed
)
"%RCEDIT%" "%INSTALLED%" --set-icon "%ICON%"
if errorlevel 1 (
    echo.
    echo [FAILED] File is locked. DeepSeek Harness is probably still running.
    echo          Quit the app first (system tray -^> Exit), then run this file again.
    goto :end
)
echo        [OK]

:skip_installed
echo.
echo [2/2] Patch dist exe (optional, for future no-reinstall distribution):
set "DISTEXE=%~dp0dist\win-unpacked\DeepSeek Harness.exe"
if exist "%DISTEXE%" (
    "%RCEDIT%" "%DISTEXE%" --set-icon "%ICON%"
    echo        [OK] %DISTEXE%
) else (
    echo        [SKIP] not found: %DISTEXE%
)

echo.
echo Done. After restarting DeepSeek Harness, the taskbar / title bar /
echo Alt-Tab / exe-file icon will be the whale.
echo (Desktop shortcut and tray icons were already updated; no extra step needed.)
echo.
pause
:end
