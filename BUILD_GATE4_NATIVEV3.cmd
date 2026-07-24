@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================================
echo TriWorld V4 Gate 4 - SUMO road, real DEM and BeamNG package
echo ============================================================
echo.

where node.exe >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or is not available in PATH.
  echo Install Node.js 22 LTS and run this file again.
  goto :failed
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm is not available in PATH.
  goto :failed
)

if not exist "node_modules\.bin\tsx.cmd" (
  echo Installing project dependencies...
  call npm install
  if errorlevel 1 goto :failed
)

echo.
echo Generating and installing triworld_v4_gate4_nativev3_real1.zip...
call npx --yes tsx src/beamng-v4/build-gate4-nativev3-cli.ts
if errorlevel 1 goto :failed

echo.
echo SUCCESS: Gate 4 package generated and installed.
echo Local ZIP:
echo   %CD%\dist\triworld_v4_gate4_nativev3_real1.zip
echo.

if defined LOCALAPPDATA (
  set "MODS_DIR=%LOCALAPPDATA%\BeamNG\BeamNG.drive\current\mods"
  if exist "%MODS_DIR%" start "" explorer.exe "%MODS_DIR%"
)

echo Start BeamNG, open Freeroam, and select:
echo   TriWorld V4 Native Gate 4 - SUMO Engineered Road and Subgrade
echo.
pause
exit /b 0

:failed
echo.
echo BUILD FAILED. Read the error above; no success was claimed.
echo.
pause
exit /b 1
