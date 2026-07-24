@echo off
setlocal
cd /d "%~dp0"

echo Building ROADFIX03 shared-world-frame terrain-projected road level...
node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-roadfix03-cli.ts
if errorlevel 1 (
  echo.
  echo FAILED: ROADFIX03 build did not complete.
  exit /b 1
)

echo.
echo SUCCESS: roadfix03.zip generated and installed.
endlocal
