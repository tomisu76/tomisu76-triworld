@echo off
setlocal
cd /d "%~dp0"
echo Building TEST05 hard-surface terrain-only level...
node node_modules\tsx\dist\cli.mjs src\beamng-v4\build-test05-cli.ts
if errorlevel 1 (
  echo.
  echo FAILED: TEST05 build did not complete.
  exit /b 1
)
echo.
echo SUCCESS: test05.zip generated and installed.
endlocal
