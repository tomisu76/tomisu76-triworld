@echo off
setlocal
cd /d "%~dp0"

echo Building ALIGN02 textured four-frame diagnostic level...
node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-align02-cli.ts
if errorlevel 1 (
  echo.
  echo FAILED: ALIGN02 build did not complete.
  exit /b 1
)

echo.
echo SUCCESS: align02.zip generated, verified, and installed.
endlocal
