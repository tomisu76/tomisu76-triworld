@echo off
setlocal
cd /d "%~dp0"

echo Building ROADFIX01 terrain-projected SUMO road level...
node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-roadfix01-cli.ts
if errorlevel 1 (
  echo.
  echo FAILED: ROADFIX01 build did not complete.
  exit /b 1
)

echo.
echo SUCCESS: roadfix01.zip generated and installed.
endlocal
