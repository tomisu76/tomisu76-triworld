@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================================
echo TriWorld V4 - Gate 3 Real OSM Recovery
echo ============================================================
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: Git was not found in PATH.
  goto :fail
)

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm was not found in PATH.
  goto :fail
)

for /f "delims=" %%B in ('git branch --show-current 2^>nul') do set "CURRENT_BRANCH=%%B"
if not defined CURRENT_BRANCH (
  echo ERROR: This folder is not a valid Git working tree.
  goto :fail
)

for /f "delims=" %%S in ('git status --porcelain') do set "DIRTY=1"
if defined DIRTY (
  echo ERROR: The working tree contains uncommitted changes.
  echo Commit or stash them before running this verifier.
  git status --short
  goto :fail
)

echo [1/7] Fetching the recovery branch...
git fetch origin codex/beamng-v4-gate3-recovery
if errorlevel 1 goto :fail

echo [2/7] Switching to codex/beamng-v4-gate3-recovery...
git switch codex/beamng-v4-gate3-recovery 2>nul
if errorlevel 1 (
  git switch --track origin/codex/beamng-v4-gate3-recovery
  if errorlevel 1 goto :fail
)

echo [3/7] Fast-forwarding to the current remote commit...
git pull --ff-only origin codex/beamng-v4-gate3-recovery
if errorlevel 1 goto :fail

echo [4/7] Installing exact dependencies...
call npm ci
if errorlevel 1 goto :fail

echo [5/7] Running TypeScript and Vite build...
call npm run build
if errorlevel 1 goto :fail

echo [6/7] Running the complete automated test suite...
call npx vitest run
if errorlevel 1 goto :fail

echo [7/7] Building and installing the real OSM Gate 3 BeamNG package...
call npx tsx src/beamng-v4/build-gate3-cli.ts
if errorlevel 1 goto :fail

echo.
echo ============================================================
echo SUCCESS
echo Open BeamNG and select:
echo TriWorld V4 Native Gate 3 - Real OSM Road
echo.
echo Build report:
echo artifacts\gate3-osm\gate3-build-report.json
echo.
echo Installed mod:
echo C:\Users\tomisu\AppData\Local\BeamNG\BeamNG.drive\current\mods\triworld_v4_gate3_osm.zip
echo ============================================================
pause
exit /b 0

:fail
echo.
echo ============================================================
echo FAILED - Gate 3 was not installed.
echo Review the error above. No success claim has been made.
echo ============================================================
pause
exit /b 1
