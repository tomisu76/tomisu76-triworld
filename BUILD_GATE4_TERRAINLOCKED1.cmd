@echo off
setlocal
cd /d "%~dp0"

echo Building isolated Gate 4 terrain-locked runtime level...
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-gate4-terrainlocked1-cli.ts
if errorlevel 1 goto :fail

echo.
echo SUCCESS: triworld_v4_gate4_terrainlocked1.zip generated and installed.
exit /b 0

:fail
echo.
echo FAILED: terrain-locked Gate 4 build did not complete.
exit /b 1
