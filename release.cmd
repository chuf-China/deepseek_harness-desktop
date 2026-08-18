@echo off
setlocal
rem One-click release: bump version -> build -> commit -> tag -> push.
rem CI (GitHub Actions) then builds, signs and uploads the Release automatically.
rem Usage: release.cmd [new-version, e.g. 0.2.0]   (no arg = keep current version)
rem NOTE: keep this file pure ASCII (cmd reads .cmd with the ANSI codepage).

set "PROJ=%~dp0"
rem %~dp0 ends with a backslash, which breaks "path\" quote pairing for git -C
if "%PROJ:~-1%"=="\" set "PROJ=%PROJ:~0,-1%"

echo ============================================================
echo   DeepSeek Harness release helper
echo ============================================================
echo.

rem ---- check git remote ----
git -C "%PROJ%" remote get-url origin >nul 2>&1
if errorlevel 1 (
    echo [ERROR] No git remote "origin" configured.
    echo         Create a GitHub repo first, then:
    echo           git remote add origin https://github.com/YOU/REPO.git
    goto :fail
)

rem ---- refuse to release with uncommitted changes ----
rem release.cmd 用 git add -A 提交：未提交的 WIP/临时改动会被静默卷进发布 commit。
rem 先检查工作树是否干净，有未提交改动就直接失败（先手动 commit/stash 再发布）。
git -C "%PROJ%" status --porcelain > "%PROJ%_dirty.tmp" 2>nul
set "DIRTY="
set /p DIRTY=<"%PROJ%_dirty.tmp"
del "%PROJ%_dirty.tmp" 2>nul
if defined DIRTY (
    echo [ERROR] Working tree has uncommitted changes:
    git -C "%PROJ%" status --short
    echo.
    echo         Commit or stash them first, then rerun release.cmd.
    goto :fail
)

rem ---- ensure bundled node sidecar exists (node\ is gitignored) ----
if exist "%PROJ%node\node.exe" goto :node_ok
echo [1/3] Creating bundled node sidecar from system node...
where node >nul 2>&1
if errorlevel 1 (
    echo        [ERROR] system node not found in PATH. Install Node.js ^>= 18 first.
    goto :fail
)
if not exist "%PROJ%node" mkdir "%PROJ%node"
for /f "delims=" %%i in ('where node') do if not exist "%PROJ%node\node.exe" copy /y "%%i" "%PROJ%node\node.exe" >nul
goto :node_done
:node_ok
echo [1/3] Bundled node sidecar already exists: node\node.exe
:node_done

rem ---- optional version bump ----
set "NEWVER=%~1"
if "%NEWVER%"=="" goto :no_bump
echo [2/3] Bumping version to %NEWVER% ...
pushd "%PROJ%"
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('package.json','utf8'));j.version=process.argv[1];fs.writeFileSync('package.json',JSON.stringify(j,null,2)+'\n')" "%NEWVER%"
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" ( echo        [ERROR] version bump failed & goto :fail )
goto :after_bump
:no_bump
echo [2/3] Keeping current version.
:after_bump

rem ---- read current version back ----
pushd "%PROJ%"
node -e "require('fs').writeFileSync('_ver.tmp', JSON.parse(require('fs').readFileSync('package.json','utf8')).version)"
set /p VER=<_ver.tmp
del _ver.tmp
popd

rem ---- local build (sanity check; CI rebuilds anyway) ----
echo [3/3] Building locally (npm run dist)...
pushd "%PROJ%"
call npm.cmd run dist
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" ( echo        [ERROR] build failed & goto :fail )

rem ---- commit + tag + push ----
git -C "%PROJ%" add -A
git -C "%PROJ%" commit -m "chore: release v%VER%" >nul 2>&1
git -C "%PROJ%" tag "v%VER%"
echo Pushing to origin (tag v%VER%)...
git -C "%PROJ%" push origin HEAD
if errorlevel 1 ( echo        [ERROR] push failed & goto :fail )
git -C "%PROJ%" push origin "v%VER%"
if errorlevel 1 ( echo        [ERROR] tag push failed & goto :fail )

echo.
echo Done. GitHub Actions is now building the Release.
echo Watch it at: https://github.com/  (Actions tab)
echo.
exit /b 0
:fail
echo.
echo [ABORTED] See errors above.
exit /b 1
