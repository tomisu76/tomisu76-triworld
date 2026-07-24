@echo off
setlocal
cd /d "%~dp0"
echo Building TEST08 shared terrain and DAE frame level...
node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-test08-cli.ts
if errorlevel 1 (
  echo.
  echo FAILED: test08 build did not complete.
  exit /b 1
)
echo.
echo SUCCESS: test08.zip generated and installed.
endlocal
