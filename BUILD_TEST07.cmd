@echo off
setlocal
cd /d "%~dp0"
echo Building TEST07 visible-road diagnostic level...
node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-test07-cli.ts
if errorlevel 1 (
  echo.
  echo FAILED: TEST07 build did not complete.
  exit /b 1
)
echo.
echo SUCCESS: test07.zip generated and installed.
endlocal
