@echo off
setlocal
cd /d "%~dp0"
echo Building TEST06 hard-terrain visual-road level...
node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-test06-cli.ts
if errorlevel 1 (
  echo.
  echo FAILED: test06 build did not complete.
  exit /b 1
)
echo.
echo SUCCESS: test06.zip generated and installed.
endlocal
